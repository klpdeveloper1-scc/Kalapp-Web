require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 📧 Mailer Dependencies (NEW)
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

// 🤖 Google Generative AI & Auth
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OAuth2Client } = require('google-auth-library');

// ☁️ Cloudinary Configuration for Permanent Storage
const cloudinary = require('cloudinary').v2;

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

// --- Google Mailer Configuration ---
const mailerOAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);
mailerOAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

// --- Middleware ---
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- Temp Memory Storage (Used for both Preview AND Final Upload) ---
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

// --- 🚀 FAST AI MODERATOR (Reads from Memory Buffer) ---
async function scanImageBufferWithAI(buffer, mimeType, category) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash',
            generationConfig: { responseMimeType: "application/json" } 
        });
        const prompt = `You are a smart complaint classifier for a Philippine barangay complaint system called Kalapp.
        The citizen reported this under the category ${category}.
        Analyze the uploaded photo and determine if it is a legitimate barangay complaint image.
        IMPORTANT RULES — BE LENIENT AND HELPFUL
        - ACCEPT the report if the photo shows ANY real-world scene (street, building, garbage, people, vehicles, damage, etc.).
        - Even blurry, dark, or low-quality photos are ACCEPTABLE as long as you can tell it is a real place or situation.
        - Only REJECT if the photo is CLEARLY a troll.
        - When in doubt, ACCEPT — it is better to forward a borderline report than to reject a real one.
        - Do not reject just because the photo is dark, blurry, or taken at night.
        Respond ONLY with this valid JSON schema:
        {
          "accepted": boolean,
          "summary": string
        }`;
        const imagePart = {
            inlineData: {
                data: buffer.toString('base64'),
                mimeType: mimeType || 'image/jpeg'
            }
        };
        const result = await model.generateContent([prompt, imagePart]);
        const parsed = JSON.parse(result.response.text()); 
        
        console.log(`🤖 AI Scan Result for [${category}] accepted=${parsed.accepted}`);
        return parsed.accepted === true;
    } catch (error) {
        console.error('AI Scan Error', error);
        return true; // fail open
    }
}

// --- SEED SUPERADMIN ---
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
            if (user.authMethod === 'local' && !user.otp) return res.status(400).json({ message: 'Email already in use.' });
        }

        if (!user) {
            user = new User({ username: username || email.split('@')[0], email, password, role: 'citizen', authMethod: 'local' });
        }

        user.otp = otp;
        user.otpExpires = new Date(Date.now() + 10 * 60000);
        await user.save();

        try {
            const accessToken = await mailerOAuth2Client.getAccessToken();
            const transport = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    type: 'OAuth2',
                    user: process.env.GMAIL_ADDRESS,
                    clientId: process.env.GMAIL_CLIENT_ID,
                    clientSecret: process.env.GMAIL_CLIENT_SECRET,
                    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
                    accessToken: accessToken.token,
                },
            });
            const mailOptions = {
                from: `System Admin <${process.env.GMAIL_ADDRESS}>`,
                to: email,
                subject: "Your Kalapp Verification Code",
                html: `<h2>Code: ${otp}</h2>`,
            };
            await transport.sendMail(mailOptions);
            res.json({ message: 'OTP sent!' });
            
        } catch (error) {
            console.error('GMAIL MAILER ERROR:', error);
            res.status(500).json({ message: 'Failed to send OTP.' });
        }
    } catch (outerError) { 
        console.error('DATABASE/SERVER ERROR:', outerError);
        if (!res.headersSent) res.status(500).json({ message: 'Internal server error.' });
    } 
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
    if (user) {
        user.otp = undefined; user.otpExpires = undefined;
        await user.save();
        res.json({ message: 'Login successful!', username: user.username, role: user.role });
    } else { res.status(400).json({ message: 'Invalid OTP.' }); }
});

app.post('/api/google-login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name;

        let user = await User.findOne({ email });
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Suspended.' });
            if (user.authMethod !== 'google') return res.status(400).json({ message: 'Use OTP Login.' });
            return res.json({ success: true, username: user.username, role: user.role });
        }
        
        user = new User({ username: name, email: email, role: 'citizen', authMethod: 'google' });
        await user.save();
        res.json({ success: true, username: user.username, role: user.role });
    } catch (error) { 
        console.error('Google Auth Error:', error);
        res.status(401).json({ message: 'Google login failed or token invalid.' }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
        if (user.status === 'blocked') return res.status(403).json({ message: 'Account suspended.' });
        res.json({ success: true, username: user.username, role: user.role });
    } else { res.status(401).json({ message: 'Invalid credentials.' }); }
});

// --- AI CLASSIFY PREVIEW ENDPOINT ---
app.post('/api/classify-preview', memoryUpload.single('evidence'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided.' });

        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash',
            generationConfig: { responseMimeType: "application/json" }
        });
        
        const prompt = `You are a smart complaint classifier for a Philippine barangay complaint system called Kalapp.

        Your job is to:
        1. Analyze the uploaded photo and assign the most fitting category from ONLY these 5 options:
           - Infrastructure & Public Works
           - Environment & Sanitation
           - Peace, Order & Public Safety
           - Inter-Personal Disputes (Lupon / Mediation)
           - Business & Ordinance Violations

        2. Assign a priority level: CRITICAL, HIGH, MEDIUM, or LOW.
           - CRITICAL: Immediate danger to life, health, or safety
           - HIGH: Significant disruption or public health risk
           - MEDIUM: Notable community issue needing action within days
           - LOW: Minor concern or informational

        3. Write a short AI summary (1-2 sentences) describing what you observe.
        IMPORTANT RULES — BE LENIENT AND HELPFUL
        - ACCEPT the report if the photo shows ANY real-world scene.
        - Only REJECT if the photo is CLEARLY a troll.
        Respond ONLY with this valid JSON schema:
        {
          "accepted": boolean,
          "category": string,
          "priority": string,
          "summary": string
        }`;
        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString('base64'),
                mimeType: req.file.mimetype
            }
        };
        const result = await model.generateContent([prompt, imagePart]);
        const parsed = JSON.parse(result.response.text());
        
        console.log(`🔍 AI Preview Classify: accepted=${parsed.accepted}, category=${parsed.category}, priority=${parsed.priority}`);
        res.json(parsed);
    } catch (error) {
        console.error('AI Classify Preview Error', error);
        res.json({ accepted: null, category: null, priority: null, summary: null });
    }
});

// --- 🚀 FAST FINAL COMPLAINT SUBMISSION ---
app.post('/api/complaints', memoryUpload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description, contactNumber, locationLat, locationLng, locationAddress, locationSource, priority } = req.body;
        const user = await User.findOne({ username });

        if (user && user.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'Your account is BLOCKED.' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No photo uploaded.' });
        }

        // 1. Instantly scan the image from memory
        const isApproved = await scanImageBufferWithAI(req.file.buffer, req.file.mimetype, issue);
        
        if (!isApproved) {
            if (user) {
                user.strikes += 1;
                if (user.strikes >= 3) user.status = 'blocked';
                await user.save();
                return res.status(400).json({
                    success: false,
                    message: `❌ AI Rejected: Photo doesn't match category. Strike ${user.strikes}/3.${user.status === 'blocked' ? ' Your account is now BLOCKED.' : ''}`
                });
            }
            return res.status(400).json({ success: false, message: '❌ AI Rejected: Photo mismatch.' });
        }

        // 2. Upload to Cloudinary securely using stream 
        const imageUrl = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({ folder: 'evidence_uploads' }, (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            });
            stream.end(req.file.buffer);
        });

        // 3. Save to Database using the locked-in priority from the frontend
        const newComplaint = new Complaint({
            trackingId: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
            citizenName: username, barangay, category: issue, description, imageUrl,
            status: 'Pending',
            priority: priority || 'MEDIUM', // Uses exact priority from frontend preview
            contactNumber: contactNumber || '',
            locationLat: locationLat ? parseFloat(locationLat) : null,
            locationLng: locationLng ? parseFloat(locationLng) : null,
            locationAddress: locationAddress || '',
            locationSource: locationSource || '',
            history: [{ status: 'Pending', note: 'Complaint officially filed.', updatedBy: username || 'System' }]
        });
        
        await newComplaint.save();
        broadcast('complaint_update', { action: 'new' });
        res.json({ success: true, message: 'Complaint submitted!', trackingId: newComplaint.trackingId });
    } catch (error) { 
        console.error('UPLOAD ERROR:', error);
        res.status(500).json({ success: false, error: error.message }); 
    } 
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
                    if (user.strikes < 3) user.strikes += 1;
                    if (user.strikes >= 3) user.status = 'blocked';
                    await user.save();
                }
            }
        }

        await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            {
                $set: updateData,
                $push: {
                    history: {
                        status: status,
                        note: note || (priority ? `Priority changed to ${priority}` : 'Status updated'),
                        updatedBy: adminName || 'LGU Admin'
                    }
                }
            }
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
    try {
        const user = await User.findById(req.params.id);
        if (user) {
            user.strikes = 0;
            await user.save();
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: 'User not found.' });
        }
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/complaints/:trackingId/history', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.trackingId });
    if (!complaint) return res.status(404).json({ error: 'Not found' });
    res.json({ history: complaint.history, trackingId: complaint.trackingId });
});

app.post('/api/complaints/:trackingId/upvote', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== 'string' || username.trim() === '') return res.status(400).json({ error: 'Username required' });
    
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
            complaint.history.push({ status: complaint.status, note: `Priority auto-bumped to ${complaint.priority} due to community validation (${complaint.upvotes} confirmations).`, updatedBy: 'System' });
        }
    }
    await complaint.save();
    broadcast('complaint_update', { action: 'upvote' });
    res.json({ success: true, upvotes: complaint.upvotes, priority: complaint.priority });
});

// --- 📄 DUAL DOCUMENT GENERATOR (Proof of Report vs Affidavit) ---
app.get('/api/complaints/:trackingId/affidavit', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.trackingId });
    if (!complaint) return res.status(404).send('Not found');
    
    const date = new Date(complaint.createdAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const today = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const type = req.query.type || 'affidavit'; // Defaults to affidavit if no type is passed

    if (type === 'proof') {
        // --- 📝 FORMAL PROOF OF REPORT TEMPLATE ---
        res.send(`
            <!DOCTYPE html><html><head><title>Proof of Report - ${complaint.trackingId}</title>
            <style>
                body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; padding: 40px; color: #000; line-height: 1.6; }
                .center { text-align: center; }
                .header { margin-bottom: 30px; }
                .title { font-size: 1.5rem; font-weight: bold; text-decoration: underline; margin: 40px 0; }
                .content { text-align: justify; text-justify: inter-word; margin-bottom: 40px; font-size: 1.1rem; }
                .signature { margin-top: 50px; float: right; width: 300px; text-align: center; }
                .line { border-top: 1px solid #000; margin-bottom: 5px; }
                @media print { body { margin: 0; padding: 20px; } button { display: none; } }
                button { display: block; margin: 20px auto; padding: 10px 20px; font-size: 1rem; cursor: pointer; background: #00bc7d; color: white; border: none; border-radius: 8px; font-family: sans-serif; font-weight: bold; }
            </style>
            </head>
            <body>
                <div class="center header">
                    <p>Republic of the Philippines<br>City of Caloocan<br><strong>BARANGAY ${complaint.barangay.toUpperCase()}</strong></p>
                    <p>OFFICE OF THE PUNONG BARANGAY</p>
                </div>
                <div class="center title">CERTIFICATION OF REPORT</div>
                <div class="content">
                    <p><strong>TO WHOM IT MAY CONCERN:</strong></p>
                    <p>This is to certify that <strong>${complaint.citizenName.toUpperCase()}</strong>, of legal age, and a resident of ${complaint.barangay}, Caloocan City, has formally logged a report through the Kalapp Complaint Management System on <strong>${date}</strong>.</p>
                    <p>The report has been recorded in our digital blotter under <strong>Tracking Number: ${complaint.trackingId}</strong> and is currently classified as <strong>${complaint.category}</strong>. The incident described is as follows:</p>
                    <p style="margin-left: 40px; font-style: italic;">"${complaint.description}"</p>
                    <p>This report is currently marked as <strong>${complaint.status.toUpperCase()}</strong> and is undergoing verification and appropriate action by the Barangay authorities.</p>
                    <p>This certification is issued upon the request of the interested party for employment, academic, or any legal purpose it may serve.</p>
                    <p>Issued this <strong>${today}</strong> at ${complaint.barangay}, Caloocan City, Philippines.</p>
                </div>
                <div class="signature">
                    <div class="line"></div>
                    <strong>BARANGAY SYSTEM ADMINISTRATOR</strong><br>Kalapp Automated Issuance
                </div>
                <div style="clear: both;"></div>
                <button onclick="window.print()">🖨️ Print Certificate</button>
            </body></html>
        `);
    } else {
        // --- 📄 FORMAL SWORN AFFIDAVIT TEMPLATE ---
        res.send(`
            <!DOCTYPE html><html><head><title>Affidavit - ${complaint.trackingId}</title>
            <style>
                body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; padding: 40px; color: #000; line-height: 1.6; }
                .center { text-align: center; }
                .header { margin-bottom: 30px; }
                .title { font-size: 1.5rem; font-weight: bold; margin: 40px 0; }
                .content { text-align: justify; text-justify: inter-word; margin-bottom: 40px; font-size: 1.1rem; }
                .jurat { margin-top: 40px; }
                .signature { margin-top: 50px; float: right; width: 300px; text-align: center; }
                .line { border-top: 1px solid #000; margin-bottom: 5px; }
                @media print { body { margin: 0; padding: 20px; } button { display: none; } }
                button { display: block; margin: 20px auto; padding: 10px 20px; font-size: 1rem; cursor: pointer; background: #ff8c00; color: white; border: none; border-radius: 8px; font-family: sans-serif; font-weight: bold; }
            </style>
            </head>
            <body>
                <div class="center header">
                    <p>Republic of the Philippines<br>City of Caloocan<br><strong>BARANGAY ${complaint.barangay.toUpperCase()}</strong></p>
                    <p>OFFICE OF THE LUPON TAGAPAMAYAPA</p>
                </div>
                <div class="center title">SWORN AFFIDAVIT OF COMPLAINT</div>
                <div class="content">
                    <p>I, <strong>${complaint.citizenName.toUpperCase()}</strong>, of legal age, Filipino, and a resident of ${complaint.barangay}, Caloocan City, after having been duly sworn to in accordance with law, hereby depose and state that:</p>
                    <ol>
                        <li style="margin-bottom: 10px;">On <strong>${date}</strong>, I filed a formal complaint through the Kalapp Complaint Management System (Tracking Number: <strong>${complaint.trackingId}</strong>).</li>
                        <li style="margin-bottom: 10px;">The nature of the complaint falls under the category of <strong>${complaint.category}</strong>.</li>
                        <li style="margin-bottom: 10px;">The complete details of the incident are truthfully recounted as follows:
                            <br><br><em>"${complaint.description}"</em><br><br>
                        </li>
                        <li style="margin-bottom: 10px;">The Barangay authorities have processed this complaint and marked it as <strong>${complaint.status.toUpperCase()}</strong> in the digital registry.</li>
                        <li style="margin-bottom: 10px;">I am executing this affidavit to attest to the truth of the foregoing facts and to support the filing of formal charges, insurance claims, or mediation proceedings as necessary.</li>
                    </ol>
                </div>
                <div class="signature">
                    <strong>${complaint.citizenName.toUpperCase()}</strong><br>
                    <div class="line" style="margin-top: 40px;"></div>
                    <small>Affiant's Signature over Printed Name</small>
                </div>
                <div style="clear: both;"></div>
                <div class="jurat content">
                    <p><strong>SUBSCRIBED AND SWORN</strong> to before me this <strong>${today}</strong> at ${complaint.barangay}, Caloocan City, Philippines. I hereby certify that I have personally examined the affiant and that I am satisfied that they voluntarily executed and understood their affidavit.</p>
                </div>
                <div class="signature" style="float: left;">
                    <div class="line" style="margin-top: 40px;"></div>
                    <strong>PUNONG BARANGAY / ADMINISTERING OFFICER</strong>
                </div>
                <div style="clear: both;"></div>
                <button onclick="window.print()">🖨️ Print Affidavit</button>
            </body></html>
        `);
    }
});

// --- AI LUPON ELIGIBILITY ANALYZER ---
async function analyzeLuponEligibility(description) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash',
            generationConfig: { responseMimeType: "application/json" }
        });
        const prompt = `You are an assistant for a Philippine barangay complaint system.
        Analyze the following complaint description and determine if it is eligible for Lupon Tagapamayapa mediation.
        Description: ${description}

        Check for:
        1. Does the description mention a respondent (neighbor, person, kapwa, individual, katabi, etc.)
        2. Does it contain a Philippine contact number?
        Look for formats 09XXXXXXXXX, +639XXXXXXXXX, or a landline like (02) XXXX-XXXX or 8XXX-XXXX.
        3. Is this a civil/community/interpersonal dispute (not a public infrastructure issue like potholes or broken streetlights)

        Respond ONLY with a valid JSON object in this schema:
        {
            "eligible": boolean,
            "hasContact": boolean,
            "hasRespondent": boolean,
            "isCivilDispute": boolean,
            "reason": string
        }`;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error('Lupon Eligibility AI Error', error);
        return { eligible: false, hasContact: false, hasRespondent: false, isCivilDispute: false, reason: 'AI analysis unavailable.' };
    }
}

app.post('/api/complaints/:id/refer-lupon', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        const { note, adminName } = req.body;
        const complaint = await Complaint.findOne({ trackingId: req.params.id });
        if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found.' });

        const analysis = await analyzeLuponEligibility(complaint.description || '');

        if (!analysis.eligible || !analysis.hasContact) {
            return res.status(400).json({
                success: false,
                message: `⚖️ Lupon referral rejected: The complaint description must include the respondent's contact number (e.g., 09XXXXXXXXX) for Lupon to schedule mediation. No strike added.`
            });
        }

        await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            {
                $set: { status: 'Referred to Lupon', lguNote: note || 'Escalated to Barangay Lupon Tagapamayapa for mediation.' },
                $push: {
                    history: {
                        status: 'Referred to Lupon',
                        note: note || 'Escalated to Barangay Lupon Tagapamayapa for mediation.',
                        updatedBy: adminName || 'LGU Admin'
                    }
                }
            }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to refer to Lupon.' }); }
});

app.get('/api/complaints/track/:id', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
    const complaint = await Complaint.findOne({ trackingId: req.params.id });
    if (!complaint) return res.status(404).json({ message: 'Report not found.' });
    res.json({ complaint: {
        trackingId: complaint.trackingId,
        category: complaint.category,
        barangay: complaint.barangay,
        status: complaint.status,
        priority: complaint.priority,
        lguNote: complaint.lguNote,
        history: complaint.history,
        createdAt: complaint.createdAt,
        affidavitApproved: complaint.affidavitApproved
    }});
});

app.post('/api/complaints/:id/request-affidavit', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        const complaint = await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $set: { affidavitRequested: true } });
        if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found.' });
        broadcast('complaint_update', { action: 'affidavit_requested', trackingId: req.params.id });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to request affidavit.' }); }
});

app.post('/api/complaints/:id/approve-affidavit', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        const complaint = await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $set: { affidavitApproved: true } });
        if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found.' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to approve affidavit.' }); }
});

app.post('/api/complaints/:id/progress-photo', rateLimit({ windowMs: 60000, max: 10 }), memoryUpload.single('photo'), async (req, res) => {
    try {
        const { note, adminName } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

        const photoUrl = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({ folder: 'evidence_uploads' }, (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            });
            stream.end(req.file.buffer);
        });

        const complaint = await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            { $push: { history: { status: 'Progress Update', note: note || 'LGU uploaded a progress photo.', updatedBy: adminName || 'LGU Admin', photoUrl } } }
        );
        if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
        broadcast('complaint_update', { action: 'progress_photo' });
        res.json({ success: true, photoUrl });
    } catch (error) { res.status(500).json({ error: 'Failed to upload progress photo.' }); }
});

// Chat endpoint
app.post('/api/ai-chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: `You are 'Sumbong-Bot', official AI of Kalapp. Tone: Empathetic, uses 'po/opo', Taglish. 
            Rules: No Markdown (** or #). Keep it plain text. Ask 4 Ws only if reporting. Direct to form for submission.`
        });
        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        res.json({ reply: result.response.text() });
    } catch (error) {
        console.error('❌ AI ERROR', error);
        res.status(500).json({ error: 'AI Error' });
    }
});

// --- COMMUNITY FEED ---
app.get('/api/complaints/feed', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const feed = await Complaint.find({
            citizenName: { $exists: true, $ne: '' },
            status: { $nin: ['Rejected & Flagged'] },
            category: { $nin: ['Inter-Personal Disputes (Lupon / Mediation)'] }
        }).sort({ createdAt: -1 }).skip(skip).limit(limit);
        
        const total = await Complaint.countDocuments({
            citizenName: { $exists: true, $ne: '' },
            status: { $nin: ['Rejected & Flagged'] },
            category: { $nin: ['Inter-Personal Disputes (Lupon / Mediation)'] }
        });
        res.json({ feed, total, page, pages: Math.ceil(total / limit) });
    } catch (error) { res.status(500).json({ error: 'Failed to load feed.' }); }
});

app.post('/api/complaints/:id/comment', rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
    try {
        const { text, authorName } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required.' });
        const complaint = await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            { $push: { comments: { text: text.trim(), authorName: authorName || 'Anonymous' } } },
            { new: true }
        );
        if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
        broadcast('complaint_update', { action: 'comment' });
        res.json({ success: true, comments: complaint.comments });
    } catch (error) { res.status(500).json({ error: 'Failed to post comment.' }); }
});

// --- 🚨 GLOBAL ERROR CATCHER ---
app.use((err, req, res, next) => {
    console.error("🚨 CRITICAL MIDDLEWARE ERROR CAUGHT:", err);
    res.status(500).json({ 
        success: false, 
        message: "A backend service crashed before processing.", 
        details: err.message || err 
    });
});

// --- HTTP + WebSocket Server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => {}); // ignore incoming messages
});

function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, () => console.log(`🚀 Master Server running on port ${PORT}`));