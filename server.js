require('dotenv').config();
const express = require('express');
const { Storage, File } = require('megajs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================= OPTIMASI KONEKSI MONGODB UNTUK VERCEL (SERVERLESS) =================
let isConnected = false;

async function connectDB() {
    if (isConnected) return;
    
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI belum diatur di Environment Variables Vercel!");
    }

    try {
        const db = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000 // Timeout 5 detik agar tidak menggantung
        });
        isConnected = db.connections[0].readyState === 1;
        console.log('✅ Berhasil terhubung ke MongoDB Atlas!');
    } catch (err) {
        console.error('❌ Gagal terhubung ke MongoDB:', err.message);
        throw err;
    }
}

// Middleware untuk memastikan DB terhubung sebelum API dipanggil
app.use('/api', async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: "Koneksi ke Database gagal: " + error.message 
        });
    }
});

// ================= DEFINISI STRUKTUR DATABASE (SCHEMA) =================
const Album = mongoose.model('Album', new mongoose.Schema({
    _id: String, name: String
}, { versionKey: false }));

const Category = mongoose.model('Category', new mongoose.Schema({
    _id: String, name: String
}, { versionKey: false }));

const Photo = mongoose.model('Photo', new mongoose.Schema({
    _id: String, albumId: String, categoryId: String, caption: String, 
    megaLink: String, megaFileName: String
}, { versionKey: false }));

const Setting = mongoose.model('Setting', new mongoose.Schema({
    _id: String, megaFolderUrl: String
}, { versionKey: false }));

let megaStorage = null;
let isAdminAuthenticated = false;

const formatData = (arr) => arr.map(doc => ({ ...doc, id: doc._id }));

async function getFolder(parent, name) {
    try {
        if (!parent.children) { try { await parent.loadAttributes(); } catch (e) { } }
        let folder = parent.children && parent.children.find(f => f.directory && f.name === name);
        if (!folder) {
            folder = await parent.mkdir(name);
            if (parent.children && folder) parent.children.push(folder);
        }
        return folder || parent;
    } catch (e) { return parent; }
}

async function findFolderInStorage(parent, urlOrName) {
    if (!parent || !parent.children || !urlOrName) return null;
    for (const child of parent.children) {
        if (child.directory) {
            if (child.name === urlOrName || urlOrName.includes(child.name)) return child;
            if (child.nodeId && urlOrName.includes(child.nodeId)) return child;
            const found = await findFolderInStorage(child, urlOrName);
            if (found) return found;
        }
    }
    return null;
}

// ================= AUTHENTICATION & SETTINGS =================
app.post('/api/login', async (req, res) => {
    const { role, email, password } = req.body;
    if (role === 'admin') {
        try {
            megaStorage = await new Storage({ email, password }).ready;
            isAdminAuthenticated = true;
            return res.json({ success: true, role: 'admin' });
        } catch (error) {
            isAdminAuthenticated = false;
            return res.status(401).json({ success: false, message: 'Gagal login MEGA. Periksa email/password.' });
        }
    }
    return res.json({ success: true, role: 'user' });
});

app.post('/api/logout', (req, res) => {
    megaStorage = null;
    isAdminAuthenticated = false;
    res.json({ success: true });
});

const adminOnly = (req, res, next) => {
    if (!isAdminAuthenticated || !megaStorage) return res.status(403).json({ message: 'Sesi Admin habis, silakan login ulang.' });
    next();
};

app.post('/api/settings', adminOnly, async (req, res) => {
    await Setting.findByIdAndUpdate('global_settings', { megaFolderUrl: req.body.megaFolderUrl || "" }, { upsert: true });
    const settings = await Setting.findById('global_settings').lean();
    res.json({ success: true, settings: settings });
});

// ================= API CRUD MONGODB =================
app.get('/api/data', async (req, res) => {
    try {
        const albums = await Album.find().lean();
        const categories = await Category.find().lean();
        const photos = await Photo.find().lean();
        const settings = await Setting.findById('global_settings').lean() || { megaFolderUrl: "" };
        
        res.json({
            albums: formatData(albums),
            categories: formatData(categories),
            photos: formatData(photos),
            settings: settings
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal memuat data dari database." });
    }
});

app.post('/api/albums', adminOnly, async (req, res) => {
    try {
        const newAlbum = new Album({ _id: 'alb_' + Date.now(), name: req.body.name });
        await newAlbum.save();
        res.json({ id: newAlbum._id, name: newAlbum.name });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menyimpan album." });
    }
});

app.put('/api/albums/:id', adminOnly, async (req, res) => {
    await Album.findByIdAndUpdate(req.params.id, { name: req.body.name });
    res.json({ success: true });
});

app.post('/api/categories', adminOnly, async (req, res) => {
    try {
        const nameLower = req.body.name.trim().toLowerCase();
        const existing = await Category.findOne({ name: { $regex: new RegExp(`^${nameLower}$`, 'i') } });
        if (existing) return res.json({ id: existing._id, name: existing.name });

        const newCat = new Category({ _id: 'cat_' + Date.now(), name: req.body.name.trim() });
        await newCat.save();
        res.json({ id: newCat._id, name: newCat.name });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menyimpan kategori." });
    }
});

app.put('/api/categories/:id', adminOnly, async (req, res) => {
    await Category.findByIdAndUpdate(req.params.id, { name: req.body.name.trim() });
    res.json({ success: true });
});

app.put('/api/photos/:id', adminOnly, async (req, res) => {
    let updateData = {};
    if (req.body.caption !== undefined) updateData.caption = req.body.caption;
    if (req.body.categoryId) updateData.categoryId = req.body.categoryId;
    await Photo.findByIdAndUpdate(req.params.id, updateData);
    res.json({ success: true });
});

app.post('/api/photos', adminOnly, upload.array('photos', 50), async (req, res) => {
    try {
        const { albumId, categoryId, caption } = req.body;
        if (!req.files || req.files.length === 0) return res.status(400).send('Kosong');

        const targetAlbum = await Album.findById(albumId);
        const targetCategory = await Category.findById(categoryId);
        if (!targetAlbum || !targetCategory) return res.status(404).send('Data tidak valid');

        const settings = await Setting.findById('global_settings');
        let baseMegaFolder = megaStorage.root;
        if (settings && settings.megaFolderUrl) {
            try {
                if (!megaStorage.root.children) await megaStorage.root.loadAttributes();
                const foundCustom = await findFolderInStorage(megaStorage.root, settings.megaFolderUrl);
                if (foundCustom) baseMegaFolder = foundCustom;
            } catch (e) { }
        }

        const appFolder = await getFolder(baseMegaFolder, 'MoodboardApps');
        const targetMegaFolder = await getFolder(appFolder, targetAlbum.name);

        const uploadedPhotos = [];
        const existingPhotosCount = await Photo.countDocuments({ albumId, categoryId });
        let counter = existingPhotosCount + 1;

        for (const file of req.files) {
            const ext = path.extname(file.originalname) || '.jpg';
            const newFileName = `${targetAlbum.name} - ${targetCategory.name} - ${counter}${ext}`;

            let megaLink = "";
            try {
                const megaFile = await targetMegaFolder.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
                megaLink = await megaFile.link();
            } catch (err) {
                const fallbackFile = await megaStorage.root.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
                megaLink = await fallbackFile.link();
            }

            const newPhoto = new Photo({
                _id: 'img_' + Date.now() + Math.floor(Math.random() * 1000),
                albumId, categoryId, caption: caption || '',
                megaLink, megaFileName: newFileName
            });
            await newPhoto.save();
            uploadedPhotos.push({ ...newPhoto.toObject(), id: newPhoto._id });
            counter++;
        }

        res.json({ success: true, photos: uploadedPhotos });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/photos/:id', adminOnly, async (req, res) => {
    const photo = await Photo.findById(req.params.id);
    if (photo && photo.megaFileName) {
        try {
            const alb = await Album.findById(photo.albumId);
            const appF = await getFolder(megaStorage.root, 'MoodboardApps');
            const albF = await getFolder(appF, alb ? alb.name : '');
            if (albF && albF.children) {
                const targetFile = albF.children.find(f => f.name === photo.megaFileName);
                if (targetFile) await targetFile.delete();
            }
        } catch (e) { }
    }
    await Photo.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.delete('/api/categories/:id', adminOnly, async (req, res) => {
    await Category.findByIdAndDelete(req.params.id);
    await Photo.deleteMany({ categoryId: req.params.id });
    res.json({ success: true });
});

app.delete('/api/albums/:id', adminOnly, async (req, res) => {
    await Album.findByIdAndDelete(req.params.id);
    await Photo.deleteMany({ albumId: req.params.id });
    res.json({ success: true });
});

app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL dibutuhkan');
    try {
        const file = File.fromURL(url);
        await file.loadAttributes();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        file.download().pipe(res);
    } catch (e) { res.status(500).send('Gagal'); }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Server berjalan di port 3000'));
}
module.exports = app;
