// private-link.js
const form           = document.querySelector('#genForm');
const modalBackdrop  = document.querySelector('#modalBackdrop');
const modalLinkText  = document.querySelector('#modalLinkText');
const copyBtn        = document.querySelector('#copyBtn');
const openBtn        = document.querySelector('#openBtn');
const closeBtn       = document.querySelector('#closeBtn');
const photoInput     = document.querySelector('#photo');
const customDomainEl = document.querySelector('#customDomain');

function showModal(){ modalBackdrop.style.display = 'flex'; }
function hideModal(){ modalBackdrop.style.display = 'none'; }

function looksLikeSlug(s){ return /^[-A-Za-z0-9_]{3,}$/.test(s); }
function looksLikeHttpUrl(u){
  if(!u) return true;
  try{ const x=new URL(u); return x.protocol==='http:'||x.protocol==='https:'; }
  catch{ return false; }
}
function looksLikeDomain(d){
  if(!d) return true; // permite vacío (fallback a BASE_PUBLIC_URL)
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d.trim());
}

async function uploadPhotoIfPresent(slug){
  const file = photoInput.files?.[0];
  if(!file) return null;
  const fd = new FormData();
  fd.set('slug', slug);
  fd.set('file', file, file.name);
  const res = await fetch('/admin/upload-photo', { method:'POST', body:fd });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`No se pudo subir la imagen (${res.status}): ${t || 'sin detalle'}`);
  }
  const json = await res.json();
  return json.publicUrl || null;
}

async function createLink(payload){
  const res = await fetch('/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`No se pudo guardar el link (${res.status}): ${t || 'sin detalle'}`);
  }
  return res.json();
}

form.addEventListener('submit', async (e)=>{
  e.preventDefault();

  const custom_domain = String(customDomainEl.value || '').trim();
  const slug   = String(document.querySelector('#slug')?.value || '').trim();
  const name   = String(document.querySelector('#displayName')?.value || '').trim();
  const subtitle = String(document.querySelector('#subtitle')?.value || '').trim();

  const instagram = String(document.querySelector('#instagram')?.value || '').trim();
  const onlyfans  = String(document.querySelector('#onlyfans')?.value || '').trim();
  const tiktok    = String(document.querySelector('#tiktok')?.value || '').trim();

  const field    = String(document.querySelector('#mainField')?.value || 'instagram').trim().toLowerCase();
  const linkMode = document.querySelector('input[name="link_mode"]:checked')?.value || 'landing';

  if(!looksLikeSlug(slug)){ alert('Slug inválido'); return; }
  if(!name){ alert('El nombre es obligatorio'); return; }
  if(!['instagram','onlyfans','tiktok'].includes(field)){ alert('Campo principal inválido'); return; }
  if(!looksLikeDomain(custom_domain)){ alert('Dominio inválido. Ej: midominio.com'); return; }

  for(const u of [instagram, onlyfans, tiktok]){
    if(u && !looksLikeHttpUrl(u)){ alert('URL no válida: ' + u); return; }
  }

  try{
    // 1) Subir foto si hay
    const photoUrl = await uploadPhotoIfPresent(slug);

    // 2) Guardar fila
    const payload = {
      slug,
      display_name: name,
      subtitle,
      instagram: instagram || null,
      onlyfans: onlyfans || null,
      tiktok: tiktok || null,
      link_mode: linkMode,       // landing | instructions
      photo: photoUrl || null,
      custom_domain: custom_domain || null
    };
    const result = await createLink(payload);

    // 3) Mostrar modal con el link final (dominio limpio)
    const finalUrl = result?.public_url || '';
    if(!finalUrl){ throw new Error('No se recibió la URL pública'); }

    modalLinkText.textContent = finalUrl.replace(/^https?:\/\//i, '');
    openBtn.href = finalUrl;
    showModal();

  }catch(err){
    console.error(err);
    alert(err.message || 'Error guardando');
  }
});

copyBtn.addEventListener('click', async ()=>{
  try{
    await navigator.clipboard.writeText(openBtn.href || modalLinkText.textContent);
    copyBtn.textContent = 'Copiado';
    setTimeout(()=> copyBtn.textContent='Copiar', 1500);
  }catch{}
});
closeBtn.addEventListener('click', hideModal);
modalBackdrop.addEventListener('click', (e)=>{ if(e.target===modalBackdrop) hideModal(); });
