// public/private/private-link.js

const $ = sel => document.querySelector(sel);
const form = $('#genForm');
const errorBox = $('#errorBox');

const modal = $('#modalBackdrop');
const modalText = $('#modalLinkText');
const copyBtn = $('#copyBtn');
const openBtn = $('#openBtn');
const closeBtn = $('#closeBtn');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
}
function clearError() {
  errorBox.textContent = '';
  errorBox.style.display = 'none';
}
function openModal(url) {
  modalText.textContent = url;
  openBtn.href = url;
  modal.style.display = 'flex';
}
function closeModal() {
  modal.style.display = 'none';
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(modalText.textContent);
    copyBtn.textContent = '¡Copiado!';
    setTimeout(() => (copyBtn.textContent = 'Copiar'), 1200);
  } catch { /* noop */ }
});
closeBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

function isUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

// Sube la foto SÓLO al guardar
async function uploadPhotoIfNeeded(slug) {
  const fileInput = document.getElementById('photoFile');
  const file = fileInput.files?.[0];
  if (!file) return null;

  const fd = new FormData();
  fd.append('file', file);
  fd.append('slug', slug);

  const r = await fetch('/api/upload-photo', { method: 'POST', body: fd });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Fallo al subir imagen: ${t || r.status}`);
  }
  const js = await r.json();
  return js.publicUrl || null;
}

async function createOrUpdateLink(payload) {
  const r = await fetch('/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Fallo al guardar: ${t || r.status}`);
  }
  return r.json();
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearError();

  try {
    const slug = String($('#slug').value || '').trim();
    const display_name = String($('#displayName').value || '').trim();
    const subtitle = String($('#subtitle').value || '').trim();

    const link_mode = document.querySelector('input[name="link_mode"]:checked')?.value || 'landing';

    const instagram = String($('#instagram').value || '').trim();
    const onlyfans = String($('#onlyfans').value || '').trim();
    const tiktok = String($('#tiktok').value || '').trim();

    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) {
      return showError('Slug inválido (mín 3, alfanumérico, _ o -)');
    }
    if (!display_name) {
      return showError('El nombre visible es requerido');
    }

    for (const u of [instagram, onlyfans, tiktok]) {
      if (u && !isUrl(u)) return showError(`URL inválida: ${u}`);
    }

    // 1) Subir foto si se eligió
    const photoUrl = await uploadPhotoIfNeeded(slug);

    // 2) Guardar registro
    const payload = {
      slug,
      display_name,
      subtitle: subtitle || null,
      instagram: instagram || null,
      onlyfans: onlyfans || null,
      tiktok: tiktok || null,
      photo: photoUrl || null,
      link_mode // 'landing' | 'instructions'
    };

    const res = await createOrUpdateLink(payload);
    if (!res.ok) throw new Error(res.error || 'No ok');

    // 3) Mostrar modal con el public_url
    openModal(res.public_url);

    // 4) Opcional: reset del input file, pero mantenemos campos
    const fileInput = document.getElementById('photoFile');
    if (fileInput) fileInput.value = '';
  } catch (e) {
    showError(e?.message || 'Error inesperado');
  }
});
