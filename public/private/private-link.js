// private-link.js
const form           = document.querySelector('#genForm');
const modalBackdrop  = document.querySelector('#modalBackdrop');
const modalLinkText  = document.querySelector('#modalLinkText');
const copyBtn        = document.querySelector('#copyBtn');
const openBtn        = document.querySelector('#openBtn');
const closeBtn       = document.querySelector('#closeBtn');
const photoInput     = document.querySelector('#photo');

function originSafe(){ return window.location.origin.replace(/\/+$/,''); }
function showModal(){ modalBackdrop.style.display = 'flex'; }
function hideModal(){ modalBackdrop.style.display = 'none'; }

function looksLikeSlug(s){ return /^[-A-Za-z0-9_]{3,}$/.test(s); }
function looksLikeHttpUrl(u){
  if(!u) return true; // opcionales pueden ir vacíos
  try{ const x=new URL(u); return x.protocol==='http:'||x.protocol==='https:'; }
  catch{ return false; }
}

async function uploadPhotoIfPresent(slug){
  const file = photoInput.files?.[0];
  if(!file) return null;

  const fd = new FormData();
  fd.set('slug', slug);
  fd.set('file', file, file.name);

  const res = await fetch('/admin/upload-photo', { method: 'POST', body: fd });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`No se pudo subir la imagen (${res.status}): ${t || 'sin detalle'}`);
  }
  const json = await res.json();
  return json.publicUrl || null;
}

async function upsertLinkForm(payload){
  // Usa el endpoint de formulario existente /admin/new
  const formData = new URLSearchParams();
  for(const [k,v] of Object.entries(payload)){
    if(v!==undefined && v!==null) formData.set(k, String(v));
  }
  const res = await fetch('/admin/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formData.toString()
  });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`No se pudo guardar el link (${res.status}): ${t || 'sin detalle'}`);
  }
}

form.addEventListener('submit', async (e)=>{
  e.preventDefault();

  const slug      = String(document.querySelector('#slug')?.value || '').trim();
  const name      = String(document.querySelector('#displayName')?.value || '').trim();
  const subtitle  = String(document.querySelector('#subtitle')?.value || '').trim();
  const instagram = String(document.querySelector('#instagram')?.value || '').trim();
  const onlyfans  = String(document.querySelector('#onlyfans')?.value  || '').trim();
  const tiktok    = String(document.querySelector('#tiktok')?.value    || '').trim();
  const linkMode  = document.querySelector('input[name="link_mode"]:checked')?.value || 'landing';

  if(!looksLikeSlug(slug)){ alert('Slug inválido'); return; }
  if(!name){ alert('El nombre es obligatorio'); return; }
  for(const u of [instagram, onlyfans, tiktok]){
    if(u && !looksLikeHttpUrl(u)){ alert('URL no válida: ' + u); return; }
  }
  // Si es landing, OnlyFans es requerido porque /secret/:id redirige allí.
  if(linkMode === 'landing' && !onlyfans){
    alert('Debes ingresar el link de OnlyFans para usar Landing.');
    return;
  }

  try{
    // 1) Subir foto si hay
    const photoUrl = await uploadPhotoIfPresent(slug);

    // 2) Guardar fila
    const payload = {
      slug,
      display_name: name,
      subtitle,
      instagram: instagram || '',
      onlyfans:  onlyfans  || '',
      tiktok:    tiktok    || '',
      photo:     photoUrl  || '',
      link_mode: linkMode  // landing | instructions
    };
    await upsertLinkForm(payload);

    // 3) Mostrar modal con URL COMPLETA (con protocolo + host)
    const path = (linkMode === 'landing')
      ? `/searchEngine/${slug}`
      : `/instructions/${slug}`;

    const fullUrl = `${originSafe()}${path}`;
    modalLinkText.textContent = fullUrl;
    openBtn.href = fullUrl;
    showModal();

  }catch(err){
    console.error(err);
    alert(err.message || 'Error guardando');
  }
});

copyBtn.addEventListener('click', async ()=>{
  try{
    await navigator.clipboard.writeText(modalLinkText.textContent);
    copyBtn.textContent = 'Copiado';
    setTimeout(()=> copyBtn.textContent='Copiar', 1500);
  }catch{}
});
closeBtn.addEventListener('click', hideModal);
modalBackdrop.addEventListener('click', (e)=>{ if(e.target===modalBackdrop) hideModal(); });
