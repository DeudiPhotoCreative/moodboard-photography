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
        loadData();
    } else {
        alert(data.message || 'Login Gagal');
    }
}

async function loadData(targetAlbumId = null) {
    try {
        const res = await fetch('/api/data');
        const data = await res.json();
        appData = data;

        if (!activeAlbumId) {
            renderAlbums();
        }
    } catch (e) {
        console.error("Gagal sinkronisasi data.");
    }
}

function renderAlbums() {
    const container = document.getElementById('albums-container');
    container.innerHTML = '';

    // Fitur Tambah Album untuk Admin
    if (currentRole === 'admin') {
        const addCard = document.createElement('div');
        addCard.className = 'p-6 bg-gray-800 rounded-xl border border-dashed border-gray-600 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 transition';
        addCard.innerHTML = '<i class="fas fa-plus text-2xl mb-2 text-gray-400"></i><span class="text-gray-400 font-medium">Tambah Album Baru</span>';
        addCard.onclick = createAlbum;
        container.appendChild(addCard);
    }

    appData.albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'bg-gray-800 rounded-xl p-6 shadow-lg hover:shadow-2xl transition transform hover:-translate-y-1 cursor-pointer flex flex-col justify-between relative';

        let deleteBtn = '';
        if (currentRole === 'admin') {
            deleteBtn = `<button onclick="deleteAlbum(event, '${album.id}')" class="absolute top-3 right-3 text-gray-500 hover:text-red-500 p-2"><i class="fas fa-trash"></i></button>`;
        }

        card.innerHTML = `
            ${deleteBtn}
            <div onclick="viewAlbum('${album.id}')" class="pt-4">
                <i class="fas fa-folder text-yellow-500 text-4xl mb-4"></i>
                <h3 class="text-xl font-bold text-white mb-1 truncate">${album.name}</h3>
                <p class="text-gray-400 text-sm">${countPhotosInAlbum(album.id)} Foto</p>
            </div>
        `;
        container.appendChild(card);
    });
}

function countPhotosInAlbum(albumId) {
    return appData.photos.filter(p => p.albumId === albumId).length;
}

async function createAlbum() {
    const name = prompt("Masukkan nama album baru:");
    if (!name) return;
    const res = await fetch('/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (res.ok) {
        loadData();
    }
}

async function deleteAlbum(e, id) {
    e.stopPropagation();
    if (!confirm("Hapus album ini beserta seluruh kategori dan foto di dalamnya?")) return;
    const res = await fetch(`/api/albums/${id}`, { method: 'DELETE' });
    if (res.ok) loadData();
}

function viewAlbum(albumId, targetCategoryId = null) {
    activeAlbumId = albumId;
    const album = appData.albums.find(a => a.id === albumId);
    document.getElementById('album-title').innerText = album ? album.name : 'Album';

    document.getElementById('view-albums').classList.add('hidden');
    document.getElementById('view-album-detail').classList.remove('hidden');

    renderCategories(targetCategoryId);
}

function showAlbumsView() {
    activeAlbumId = null;
    activeCategoryId = null;
    document.getElementById('view-album-detail').classList.add('hidden');
    document.getElementById('view-albums').classList.remove('hidden');
    renderAlbums();
}

function renderCategories(targetCategoryId = null) {
    const container = document.getElementById('categories-tabs');
    container.innerHTML = '';

    const albumCats = appData.categories.filter(c => c.albumId === activeAlbumId);

    if (albumCats.length > 0) {
        activeCategoryId = targetCategoryId || albumCats[0].id;
    } else {
        activeCategoryId = null;
    }

    albumCats.forEach(cat => {
        const btn = document.createElement('button');
        const isActive = cat.id === activeCategoryId;
        btn.className = `px-4 py-2 rounded-lg font-medium transition whitespace-nowrap flex items-center gap-2 ${isActive ? 'bg-blue-600 text-white shadow' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`;

        let delIcon = '';
        if (currentRole === 'admin') {
            delIcon = `<i onclick="deleteCategory(event, '${cat.id}')" class="fas fa-times-circle ml-1 hover:text-red-400"></i>`;
        }

        btn.innerHTML = `<span>${cat.name}</span> ${delIcon}`;
        btn.onclick = () => switchCategory(cat.id);
        container.appendChild(btn);
    });

    if (currentRole === 'admin') {
        const addBtn = document.createElement('button');
        addBtn.className = 'px-4 py-2 rounded-lg bg-gray-800 text-dashed border border-gray-600 text-gray-400 hover:border-blue-500 transition';
        addBtn.innerHTML = '<i class="fas fa-plus mr-1"></i> Kategori';
        addBtn.onclick = createCategory;
        container.appendChild(addBtn);
    }

    renderPhotos();
}

function switchCategory(catId) {
    activeCategoryId = catId;
    const tabs = document.getElementById('categories-tabs').children;
    const albumCats = appData.categories.filter(c => c.albumId === activeAlbumId);

    albumCats.forEach((cat, idx) => {
        if (tabs[idx]) {
            const isActive = cat.id === catId;
            tabs[idx].className = `px-4 py-2 rounded-lg font-medium transition whitespace-nowrap flex items-center gap-2 ${isActive ? 'bg-blue-600 text-white shadow' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`;
        }
    });

    renderPhotos();
}

async function createCategory() {
    const name = prompt("Nama Kategori Baru (Misal: CLOSE UP, WIDE):");
    if (!name) return;
    const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumId: activeAlbumId, name: name.toUpperCase() })
    });
    if (res.ok) {
        const result = await res.json();
        loadData();
        setTimeout(() => viewAlbum(activeAlbumId, result.category.id), 500);
    }
}

async function deleteCategory(e, id) {
    e.stopPropagation();
    if (!confirm("Hapus kategori ini dan semua foto di dalamnya?")) return;
    const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    if (res.ok) {
        loadData();
        setTimeout(() => viewAlbum(activeAlbumId), 500);
    }
}

function renderPhotos() {
    const container = document.getElementById('photos-grid');
    container.innerHTML = '';

    const actionPanel = document.getElementById('admin-actions-panel');
    if (currentRole === 'admin' && activeCategoryId) {
        actionPanel.classList.remove('hidden');
    } else {
        actionPanel.classList.add('hidden');
    }

    const filteredPhotos = appData.photos.filter(p => p.albumId === activeAlbumId && p.categoryId === activeCategoryId);

    if (filteredPhotos.length === 0) {
        container.innerHTML = '<div class="col-span-full py-12 text-center text-gray-500"><i class="fas fa-images text-4xl mb-2"></i><p>Belum ada foto di kategori ini.</p></div>';
        return;
    }

    filteredPhotos.forEach(photo => {
        const item = document.createElement('div');
        item.className = 'group relative bg-gray-900 rounded-xl overflow-hidden shadow-md hover:shadow-xl transition aspect-[3/4] cursor-pointer';

        const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(photo.megaLink)}`;

        item.innerHTML = `
            <img src="${proxyUrl}" class="w-full h-full object-cover transition duration-500 group-hover:scale-105" loading="lazy">
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition duration-300 flex flex-col justify-end p-4">
                <p class="text-white font-medium text-sm line-clamp-2">${photo.caption || 'Lihat Foto'}</p>
            </div>
        `;
        container.appendChild(item);
    });
}

// ================= AMAN & TERKONTROL: UPLOAD MULTIPLE FOTO SATU PER SATU =================
function openAddPhotoModal() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true; // Admin bebas memilih puluhan foto sekaligus

    fileInput.onchange = async () => {
        const files = fileInput.files;
        if (!files || files.length === 0) return;

        const caption = prompt("Masukkan caption / instruksi pose singkat (opsional):");

        let sukses = 0;
        let gagal = 0;

        alert(`Memulai unggah ${files.length} foto secara berkala. Mohon jangan tutup halaman ini.`);

        for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append('photo', files[i]); // Mengirim 1 file per request (Ringan bagi Vercel)
            formData.append('albumId', activeAlbumId);
            formData.append('categoryId', activeCategoryId);
            formData.append('caption', caption || '');

            console.log(`Mengirim file ke-${i + 1} dari ${files.length}...`);

            try {
                const res = await fetch('/api/photos', { method: 'POST', body: formData });
                const result = await res.json();
                if (res.ok && result.success) {
                    sukses++;
                } else {
                    gagal++;
                }
            } catch (err) {
                gagal++;
            }

            // MEMBERIKAN JEDA AMAN (DELAY 2 DETIK) AGAR AKUN MEGA TIDAK TERBLOKIR
            if (i < files.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        alert(`Proses Selesai!\nBerhasil disimpan: ${sukses}\nGagal: ${gagal}`);
        loadData();
        setTimeout(() => {
            viewAlbum(activeAlbumId, activeCategoryId);
        }, 600);
    };
    fileInput.click();
}
