let currentRole = 'user';
let appData = { albums: [], categories: [], photos: [] };
let activeAlbumId = null;
let activeCategoryId = null;

function setRole(role) {
    currentRole = role;
    document.getElementById('btn-role-user').className = role === 'user' ? 'flex-1 py-2 bg-blue-600 text-white rounded-lg' : 'flex-1 py-2 bg-gray-700 text-gray-400 rounded-lg';
    document.getElementById('btn-role-admin').className = role === 'admin' ? 'flex-1 py-2 bg-blue-600 text-white rounded-lg' : 'flex-1 py-2 bg-gray-700 text-gray-400 rounded-lg';
    document.getElementById('admin-fields').className = role === 'admin' ? 'mb-4 block' : 'hidden';
}

async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: currentRole, email, password })
    });
    const data = await res.json();

    if (data.success) {
        document.getElementById('view-login').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        
        if (currentRole === 'admin') {
            document.querySelectorAll('#admin-add-album-btn, #admin-add-cat-btn, #admin-add-photo-btn').forEach(el => el.classList.remove('hidden'));
        }
        loadData();
    } else {
        alert(data.message);
    }
}

async function loadData() {
    const res = await fetch('/api/data');
    appData = await res.json();
    renderAlbums();
}

function renderAlbums() {
    showAlbumsView();
    const list = document.getElementById('albums-list');
    list.innerHTML = appData.albums.map(alb => `
        <div onclick="viewAlbum('${alb.id}')" class="bg-gray-800 p-5 rounded-xl border border-gray-700 flex justify-between items-center cursor-pointer active:scale-95 transition-transform">
            <span class="font-bold text-lg text-white">📁 ${alb.name}</span>
            <span class="text-gray-400 text-sm">&rarr;</span>
        </div>
    `).join('');
}

function viewAlbum(albumId) {
    activeAlbumId = albumId;
    document.getElementById('view-albums').classList.add('hidden');
    document.getElementById('view-album-detail').classList.remove('hidden');
    
    // Filter Kategori milik Album ini
    const cats = appData.categories.filter(c => c.albumId === albumId);
    const tabContainer = document.getElementById('categories-tabs');
    
    if (cats.length > 0) {
        activeCategoryId = cats[0].id;
        tabContainer.innerHTML = cats.map(c => `
            <button onclick="switchCategory('${c.id}')" id="tab-${c.id}" class="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap bg-gray-800 text-gray-300">
                ${c.name}
            </button>
        `).join('');
        switchCategory(activeCategoryId);
    } else {
        tabContainer.innerHTML = '<span class="text-xs text-gray-500">Belum ada kategori section</span>';
        document.getElementById('photos-grid').innerHTML = '';
    }
}

function switchCategory(catId) {
    activeCategoryId = catId;
    // Update styling tab aktif
    appData.categories.forEach(c => {
        const btn = document.getElementById(`tab-${c.id}`);
        if(btn) btn.className = c.id === catId ? 'px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap bg-blue-600 text-white' : 'px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap bg-gray-800 text-gray-300';
    });
    
    // Render Foto
    const targetPhotos = appData.photos.filter(p => p.categoryId === catId);
    const grid = document.getElementById('photos-grid');
    grid.innerHTML = targetPhotos.map(p => `
        <div class="bg-gray-800 rounded-xl overflow-hidden border border-gray-700 relative">
            <img src="/api/proxy-image?url=${encodeURIComponent(p.megaLink)}" alt="pose" class="w-full h-40 object-cover bg-gray-900">
            <div class="p-2 bg-gray-800/90 text-[11px] text-gray-300 text-center">${p.caption}</div>
        </div>
    `).join('');
}

function showAlbumsView() {
    document.getElementById('view-albums').classList.remove('hidden');
    document.getElementById('view-album-detail').classList.add('hidden');
}

// ================= FUNGSI AKSI ADMIN (CRUD PROMPT) =================
async function openAddAlbumModal() {
    const name = prompt("Masukkan nama album baru (Contoh: Wisuda, Prewedding):");
    if (!name) return;
    await fetch('/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    loadData();
}

async function openAddCatModal() {
    const name = prompt("Masukkan nama section baru (Contoh: Wide, CloseUp):");
    if (!name) return;
    await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumId: activeAlbumId, name })
    });
    loadData(activeAlbumId);
    setTimeout(() => viewAlbum(activeAlbumId), 500);
}

function openAddPhotoModal() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if(!file) return;
        const caption = prompt("Masukkan petunjuk singkat pose (optional):");
        
        const formData = new FormData();
        formData.append('photo', file);
        formData.append('albumId', activeAlbumId);
        formData.append('categoryId', activeCategoryId);
        formData.append('caption', caption);

        alert("Foto sedang diunggah ke MEGA. Mohon tunggu sejenak...");
        const res = await fetch('/api/photos', { method: 'POST', body: formData });
        if(res.ok) {
            alert("Berhasil disimpan!");
            loadData();
            setTimeout(() => { viewAlbum(activeAlbumId); switchCategory(activeCategoryId); }, 600);
        } else {
            alert("Gagal mengunggah gambar.");
        }
    };
    fileInput.click();
}

function logout() {
    fetch('/api/logout', { method: 'POST' });
    window.location.reload();
}