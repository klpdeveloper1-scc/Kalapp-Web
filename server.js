require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mongoose = require('mongoose');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

// 🤖 Google Generative AI
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ☁️ Cloudinary Configuration
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3001;

// 🆕 NEW BASE URL FOR RENDER
const BASE_WEBSITE_URL = 'https://kalapp-web.onrender.com';

// --- API Configurations ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Middleware (Updated CORS) ---
app.use(express.json());
app.use(cors({
    origin: [
        'https://kalapp-web.onrender.com', 
        'http://localhost:3000', 
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Cloudinary Multer Storage ---
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'kalapp_evidence', allowed_formats: ['jpg', 'png', 'jpeg', 'webp'] }
});
const upload = multer({ storage: storage });

// --- MongoDB Setup ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

const complaintSchema = new mongoose.Schema({
    trackingId: { type: String, unique: true },
    citizenName: String,
    barangay: String,
    category: String,
    description: String,
    contactNumber: String,
    locationLat: String,
    locationLng: String,
    locationAddress: String,
    locationSource: String,
    imageUrl: String,
    priority: { type: String, default: 'MEDIUM' },
    status: { type: String, default: 'Pending' },
    lguNote: String,
    upvotes: { type: Number, default: 0 },
    affidavitRequested: { type: Boolean, default: false },
    affidavitApproved: { type: Boolean, default: false },
    comments: [{ text: String, authorName: String, createdAt: { type: Date, default: Date.now } }],
    history: [{ status: String, note: String, updatedBy: String, photoUrl: String, updatedAt: { type: Date, default: Date.now } }],
    createdAt: { type: Date, default: Date.now }
});
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- HTTP + WebSocket Server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});

function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);

// --- Routes ---

// Get All Complaints
app.get('/api/complaints', async (req, res) => {
    try {
        const complaints = await Complaint.find().sort({ createdAt: -1 });
        res.json({ success: true, complaints });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// Community Feed
app.get('/api/complaints/feed', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const feed = await Complaint.find({ status: { $ne: 'Rejected & Flagged' } })
            .sort({ createdAt: -1 }).skip(skip).limit(limit);
        const total = await Complaint.countDocuments({ status: { $ne: 'Rejected & Flagged' } });
        res.json({ success: true, feed, pages: Math.ceil(total / limit) });
    } catch (error) { res.status(500).json({ success: false }); }
});

// Submit Complaint
app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const trackingId = 'KAL-' + Math.floor(1000 + Math.random() * 9000);
        const { username, barangay, issue, description, contactNumber, locationLat, locationLng, locationAddress, locationSource } = req.body;
        const imageUrl = req.file ? req.file.path : '';

        const newComplaint = new Complaint({
            trackingId, citizenName: username, barangay, category: issue, description,
            contactNumber, locationLat, locationLng, locationAddress, locationSource,
            imageUrl, status: 'Pending', history: [{ status: 'Pending', note: 'Complaint submitted by citizen.', updatedBy: username }]
        });
        
        await newComplaint.save();
        broadcast('new_complaint', newComplaint);
        res.json({ success: true, trackingId, message: 'Complaint submitted successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to upload complaint.' });
    }
});

// Update Status (LGU)
app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        const { status, note, adminName, priority } = req.body;
        const updateData = { status, lguNote: note };
        if (priority) updateData.priority = priority;

        const complaint = await Complaint.findOneAndUpdate(
            { trackingId: req.params.id },
            { $set: updateData, $push: { history: { status, note, updatedBy: adminName } } },
            { new: true }
        );
        if (!complaint) return res.status(404).json({ error: 'Not found' });
        broadcast('status_update', complaint);
        res.json({ success: true, complaint });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// Upvote
app.post('/api/complaints/:id/upvote', async (req, res) => {
    try {
        const complaint = await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { $inc: { upvotes: 1 } }, { new: true });
        broadcast('upvote', { trackingId: complaint.trackingId, upvotes: complaint.upvotes });
        res.json({ success: true, upvotes: complaint.upvotes });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// Start Server
server.listen(PORT, () => {
    console.log(`🚀 Server running dynamically on Render at port ${PORT}`);
});