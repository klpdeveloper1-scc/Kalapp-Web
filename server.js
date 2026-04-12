require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 📧 Mailer Dependencies
const nodemailer = require('nodemailer');

// 🤖 Google Generative AI & Auth
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OAuth2Client } = require('google-auth-library');

// ☁️ Cloudinary Configuration
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// --- API Configurations ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Middleware ---
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- Cloudinary Multer Storage ---
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'evidence_uploads', allowed_formats: ['jpg', 'png', 'jpeg', 'webp'] },
});
const upload = multer({ storage: storage });
const memoryUpload = multer({ storage: multer.memoryStorage() });

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error', err));

// --- Schemas & Models ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String },
    password: { type: String },
    role: { type: String, default: 'citizen' },
    status: { type: String, default: 'active' },
    authMethod: { type: String, default: 'local' },
    otp: String,
    otpExpires: Date,
    strikes: { type: Number, default: 0 }
});

const complaintSchema = new mongoose.Schema({
    trackingId: String,
    citizenName: String,
    barangay: String,
    category: String,
    description: String,
    imageUrl: String,
    status: { type: String, default: 'Pending' },
    priority: { type: String, default: 'MEDIUM' },
    lguNote: String,
    history: [{
        status: String,
        note: String,
        updatedBy: String,
        photoUrl: { type: String, default: null },
        updatedAt: { type: Date, default: Date.now }
    }],
    upvotes: { type: Number, default: 0 },
    upvotedBy: [{ type: String }],
    comments: [{
        text: String,
        authorName: { type: String, default: 'Anonymous' },
        createdAt: { type: Date, default: Date.now }
    }],
    affidavitRequested: { type: Boolean, default: false },
    affidavitApproved: { type: Boolean, default: false },
    contactNumber: { type: String, default: '' },
    locationLat: { type: Number, default: null },
    locationLng: { type: Number, default: null },
    locationAddress: { type: String, default: '' },
    locationSource: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- AI FUNCTIONS ---
async function scanImageWithAI(imageUrl, category) {
    try {
        const response = await fetch(imageUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `You are a smart complaint classifier for a Philippine barangay system. Category: ${category}. ACCEPT if the photo shows ANY real-world scene. REJECT ONLY if clearly a troll/meme. Respond ONLY with JSON: {"accepted": true, "summary": "what you see"}`;
        const imagePart = { inlineData: { data: buffer.toString('base64'), mimeType: response.headers.get('content-type') || 'image/jpeg' } };
        const result = await model.generateContent([prompt, imagePart]);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text).accepted === true;
    } catch (error) { return true; }
}

async function analyzePriority(category, description) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Analyze this complaint: Category: ${category}, Desc: ${description}. Respond ONLY with JSON: {"priority": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW", "reason": "why"}`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text).priority;
    } catch (error) { return 'MEDIUM'; }
}

async function analyzeLuponEligibility(description) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Analyze if eligible for Lupon mediation. Desc: ${description}. Must have respondent, contact number, and be civil dispute. Respond ONLY JSON: {"eligible": true/false, "hasContact": true/false, "hasRespondent": true/false, "isCivilDispute": true/false, "reason": ""}`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (error) { return { eligible: false, hasContact: false, reason: 'AI analysis unavailable.' }; }
}

// --- SEED ADMIN ---
async function seedAdmin() {
    const admin = await User.findOne({ username: 'cityhall' });
    if (!admin) {
        await User.create({ username: 'cityhall', password: 'masterkey2026', role: 'superadmin', authMethod: 'local' });
        console.log("✅ SuperAdmin 'cityhall' created.");
    }
}
seedAdmin();

// --- API ROUTES ---

app.post('/api/request-otp', async (req, res) => {
    const { email, username, password } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    try {
        let user = await User.findOne({ email });
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Account is suspended.' });
            if (user.authMethod === 'google') return res.status(400).json({ message: 'Registered via Google.' });
        }
        if (!user) user = new User({ username: username || email.split('@')[0], email, password, role: 'citizen', authMethod: 'local' });
        
        user.otp = otp;
        user.otpExpires = new Date(Date.now() + 10 * 60000);
        await user.save();

        // --- SIMPLE NODEMAILER WITH APP PASSWORD ---
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_ADDRESS,
                pass: process.env.GMAIL_APP_PASSWORD
            }
        });

        const mailOptions = {
            from: '"Kalapp Admin" <' + process.env.GMAIL_ADDRESS + '>',
            to: email,
            subject: 'Your Kalapp Verification Code',
            html: `<div style="font-family: sans-serif; padding: 20px;"><h2>Your Verification Code</h2><p>Your Kalapp login code is: <strong style="font-size: 24px; color: #4169E1;">${otp}</strong></p><p>This code will expire in 10 minutes.</p></div>`
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ OTP sent to ${email}`);
        res.json({ message: 'OTP sent!' });

    } catch (error) { 
        console.error('❌ Server/Mailer Error:', error);
        res.status(500).json({ message: 'Internal server error or Failed to send email.' }); 
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
    if (user) {
        user.otp = undefined; user.otpExpires = undefined;
        await user.save();
        res.json({ message: 'Login successful!', username: user.username, role: user.role });
    } else { res.status(400).json({ message: 'Invalid or expired OTP.' }); }
});

app.post('/api/google-login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        let user = await User.findOne({ email: payload.email });
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Suspended.' });
            if (user.authMethod !== 'google') return res.status(400).json({ message: 'Use OTP Login.' });
            return res.json({ success: true, username: user.username, role: user.role });
        }
        user = new User({ username: payload.name, email: payload.email, role: 'citizen', authMethod: 'google' });
        await user.save();
        res.json({ success: true, username: user.username, role: user.role });
    } catch (error) { res.status(401).json({ message: 'Google login failed.' }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
        if (user.status === 'blocked') return res.status(403).json({ message: 'Account suspended.' });
        res.json({ success: true, username: user.username, role: user.role });
    } else { res.status(401).json({ message: 'Invalid credentials.' }); }
});

app.post('/api/classify-preview', memoryUpload.single('evidence'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided.' });
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Classify this Philippine barangay complaint photo into 5 categories, assign priority (CRITICAL/HIGH/MEDIUM/LOW), and summarize. ACCEPT real scenes, REJECT obvious trolls. JSON ONLY: {"accepted": true, "category": "...", "priority": "...", "summary": "..."}`;
        const imagePart = { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } };
        const result = await model.generateContent([prompt, imagePart]);
        const cleanJson = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(cleanJson));
    } catch (error) { res.json({ accepted: null, category: null, priority: null, summary: null }); }
});

app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description, contactNumber, locationLat, locationLng, locationAddress, locationSource } = req.body;
        const imageUrl = req.file ? req.file.path : '';
        const user = await User.findOne({ username });

        if (user && user.status === 'blocked') return res.status(403).json({ success: false, message: 'Your account is BLOCKED.' });

        if (imageUrl) {
            const isApproved = await scanImageWithAI(imageUrl, issue);
            if (!isApproved) {
                if (user) {
                    user.strikes += 1;
                    if (user.strikes >= 3) user.status = 'blocked';
                    await user.save();
                    return res.status(400).json({ success: false, message: `❌ AI Rejected photo. Strike ${user.strikes}/3.${user.status === 'blocked' ? ' BLOCKED.' : ''}` });
                }
                return res.status(400).json({ success: false, message: '❌ AI Rejected photo.' });
            }
        }

        const priority = description ? await analyzePriority(issue, description) : 'MEDIUM';
        const newComplaint = new Complaint({
            trackingId: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
            citizenName: username, barangay, category: issue, description, imageUrl, status: 'Pending', priority,
            contactNumber: contactNumber || '', locationLat: locationLat || null, locationLng: locationLng || null,
            locationAddress: locationAddress || '', locationSource: locationSource || '',
            history: [{ status: 'Pending', note: 'Complaint filed.', updatedBy: username || 'System' }]
        });
        await newComplaint.save();
        broadcast('complaint_update', { action: 'new' });
        res.json({ success: true, message: 'Submitted!', trackingId: newComplaint.trackingId });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/complaints', async (req, res) => {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    res.json({ complaints });
});

app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        const { status, note, adminName, priority } = req.body;
        const updateData = { status, lguNote: note };
        if (priority) updateData.priority = priority;

        if (status === 'Rejected & Flagged') {
            const complaint = await Complaint.findOne({ trackingId: req.params.id });
            if (complaint) {
                const user = await User.findOne({ username: complaint.citizenName });
                if (user) {
                    user.strikes += 1;
                    if (user.strikes >= 3) user.status = 'blocked';
                    await user.save();
                }
            }
        }

        await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            { $set: updateData, $push: { history: { status, note: note || 'Status updated', updatedBy: adminName || 'LGU Admin' } } }
        );
        broadcast('complaint_update', { action: 'status' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to update status.' }); }
});

app.get('/api/admin/users', async (req, res) => {
    const users = await User.find({ role: { $ne: 'superadmin' } });
    res.json({ users });
});

app.post('/api/admin/create-lgu', async (req, res) => {
    try {
        await new User({ username: req.body.username, email: req.body.email, password: req.body.password, role: 'lgu', authMethod: 'local' }).save();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.patch('/api/admin/users/:id/toggle-block', async (req, res) => {
    const user = await User.findById(req.params.id);
    if (user) {
        user.status = user.status === 'blocked' ? 'active' : 'blocked';
        await user.save();
        res.json({ success: true });
    }
});

app.patch('/api/admin/users/:id/reset-strikes', async (req, res) => {
    const user = await User.findById(req.params.id);
    if (user) { user.strikes = 0; await user.save(); res.json({ success: true }); } 
    else res.status(404).json({ success: false });
});

app.get('/api/complaints/:trackingId/history', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.trackingId });
    if (!complaint) return res.status(404).json({ error: 'Not found' });
    res.json({ history: complaint.history, trackingId: complaint.trackingId });
});

app.post('/api/complaints/:trackingId/upvote', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    const { username } = req.body;
    const complaint = await Complaint.findOne({ trackingId: req.params.trackingId });
    if (!complaint) return res.status(404).json({ error: 'Not found' });
    if (complaint.upvotedBy.includes(username)) return res.status(400).json({ error: 'Already upvoted' });
    
    complaint.upvotes += 1;
    complaint.upvotedBy.push(username);
    if (complaint.upvotes >= 3 && complaint.priority !== 'CRITICAL') {
        const priorityOrder = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        const idx = priorityOrder.indexOf(complaint.priority);
        if (idx < 3) {
            complaint.priority = priorityOrder[idx + 1];
            complaint.history.push({ status: complaint.status, note: `Priority auto-bumped to ${complaint.priority} due to community validation.`, updatedBy: 'System' });
        }
    }
    await complaint.save();
    broadcast('complaint_update', { action: 'upvote' });
    res.json({ success: true, upvotes: complaint.upvotes });
});

app.get('/api/complaints/:trackingId/affidavit', async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.trackingId });
    if (!complaint) return res.status(404).send('Not found');
    res.send(`<!DOCTYPE html><html><head><title>Affidavit - ${complaint.trackingId}</title></head><body><h1>Barangay Affidavit</h1><p>Citizen: ${complaint.citizenName}</p><p>Ref: ${complaint.trackingId}</p><p>Category: ${complaint.category}</p><button onclick="window.print()">Print</button></body></html>`);
});

app.post('/api/complaints/:id/refer-lupon', async (req, res) => {
    try {
        const { note, adminName } = req.body;
        const complaint = await Complaint.findOne({ trackingId: req.params.id });
        if (!complaint) return res.status(404).json({ success: false, message: 'Not found.' });
        const analysis = await analyzeLuponEligibility(complaint.description || '');
        if (!analysis.eligible || !analysis.hasContact) {
             return res.status(400).json({ success: false, message: `Lupon referral rejected: Description must include respondent's contact number.` });
        }
        await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $set: { status: 'Referred to Lupon', lguNote: note }, $push: { history: { status: 'Referred to Lupon', note: note || 'Escalated to Lupon', updatedBy: adminName } } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/complaints/track/:id', async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.id });
    if (!complaint) return res.status(404).json({ message: 'Not found.' });
    res.json({ complaint });
});

app.post('/api/complaints/:id/request-affidavit', async (req, res) => {
    await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $set: { affidavitRequested: true } });
    broadcast('complaint_update', { action: 'affidavit' });
    res.json({ success: true });
});

app.post('/api/complaints/:id/approve-affidavit', async (req, res) => {
    await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $set: { affidavitApproved: true } });
    res.json({ success: true });
});

app.post('/api/complaints/:id/progress-photo', upload.single('photo'), async (req, res) => {
    try {
        const { note, adminName } = req.body;
        const photoUrl = req.file ? req.file.path : null;
        if (!photoUrl) return res.status(400).json({ error: 'No photo.' });
        await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $push: { history: { status: 'Progress Update', note: note || 'Progress photo', updatedBy: adminName, photoUrl } } });
        broadcast('complaint_update', { action: 'progress' });
        res.json({ success: true, photoUrl });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/ai-chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: `You are 'Sumbong-Bot', official AI of Kalapp. Tone: Empathetic, Taglish. Keep it plain text.` });
        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        res.json({ reply: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'AI Error' }); }
});

app.get('/api/complaints/feed', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const feed = await Complaint.find({ citizenName: { $exists: true, $ne: '' }, status: { $nin: ['Rejected & Flagged'] }, category: { $nin: ['Inter-Personal Disputes (Lupon / Mediation)'] } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
        const total = await Complaint.countDocuments({ citizenName: { $exists: true, $ne: '' }, status: { $nin: ['Rejected & Flagged'] }, category: { $nin: ['Inter-Personal Disputes (Lupon / Mediation)'] } });
        res.json({ feed, total, page, pages: Math.ceil(total / limit) });
    } catch (error) { res.status(500).json({ error: 'Feed failed' }); }
});

app.post('/api/complaints/:id/comment', async (req, res) => {
    try {
        const complaint = await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $push: { comments: { text: req.body.text, authorName: req.body.authorName || 'Anonymous' } } }, { new: true });
        broadcast('complaint_update', { action: 'comment' });
        res.json({ success: true, comments: complaint.comments });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// --- HTTP + WebSocket Server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});

function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false; ws.ping();
    });
}, 30000);

server.listen(PORT, () => console.log(`🚀 Master Server running on port ${PORT}`));