// Consulta Overpass y regenera data/museos.geojson con el departamento de cada museo.
// Lo ejecuta GitHub Actions (.github/workflows/actualizar-museos.yml). A mano:
//   node scripts/actualizar_museos.mjs                       → consulta Overpass
//   node scripts/actualizar_museos.mjs respuesta.json        → usa una respuesta guardada
// Solo reescribe el archivo si cambió algún museo. Si Overpass no responde o responde
// incompleto, conserva el archivo anterior (aviso, no error) y se reintenta en la próxima ejecución.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = path.join(RAIZ, 'data', 'museos.geojson');
// overpass-api.de suele responder 502 por ratos cuando está saturado: más intentos.
const SERVIDORES = [
  {url:'https://overpass-api.de/api/interpreter', intentos:4},
  {url:'https://maps.mail.ru/osm/tools/overpass/api/interpreter', intentos:2},
];
// Solo museos dentro del límite nacional de Bolivia en OSM.
const CONSULTA = '[out:json][timeout:90];area["ISO3166-1"="BO"][admin_level=2]->.bo;nwr["tourism"="museum"](area.bo);out center qt;';
const MAX_KM = 25;          // más lejos que esto de todo departamento → no es Bolivia
const MIN_PROPORCION = 0.8; // si llegan muchos menos museos que antes, la respuesta se asume incompleta

/* ---------- Overpass ---------- */
async function consultarOverpass(){
  const body = new URLSearchParams({data: CONSULTA}).toString();
  for (const {url, intentos} of SERVIDORES){
    for (let intento = 1; intento <= intentos; intento++){
      try{
        const r = await fetch(url, {
          method:'POST', body, signal: AbortSignal.timeout(150_000),
          headers:{
            'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json',
            'User-Agent':'museum03-geoportal (github.com/silvanaesther43/museum03)',
          },
        });
        if (!r.ok) throw new Error('HTTP '+r.status);
        const j = await r.json();
        if (!j.elements?.length) throw new Error('respuesta vacía');
        console.log(`Overpass: ${j.elements.length} elementos desde ${url}`);
        return j;
      }catch(e){
        console.warn(`${url} (intento ${intento}): ${e.message}`);
        if (intento < intentos) await new Promise(res=>setTimeout(res, 30_000*intento));
      }
    }
  }
  throw new Error('Ningún servidor Overpass respondió');
}

/* ---------- Departamentos (mismos polígonos que dibuja la página) ---------- */
const ctx = {};
ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'departamentos.js'), 'utf8'), ctx);
const DEPT_POLYS = ctx.BOLIVIA_DEPARTAMENTOS.features.map(f=>({
  nombre: f.properties.nombre,
  polys: f.geometry.type==='Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
}));

function inRing(lon, lat, ring){
  let dentro = false;
  for (let i=0, j=ring.length-1; i<ring.length; j=i++){
    const [xi,yi] = ring[i], [xj,yj] = ring[j];
    if ((yi>lat)!==(yj>lat) && lon < (xj-xi)*(lat-yi)/(yj-yi)+xi) dentro = !dentro;
  }
  return dentro;
}
function ringDistKm(lat, lon, ring){
  const kx = 111.32*Math.cos(lat*Math.PI/180), ky = 110.57;
  let min = Infinity;
  for (let i=1; i<ring.length; i++){
    const ax=(ring[i-1][0]-lon)*kx, ay=(ring[i-1][1]-lat)*ky;
    const bx=(ring[i][0]-lon)*kx,   by=(ring[i][1]-lat)*ky;
    const dx=bx-ax, dy=by-ay;
    const t = Math.max(0, Math.min(1, -(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
    min = Math.min(min, Math.hypot(ax+t*dx, ay+t*dy));
  }
  return min;
}
function asignarDepartamento(lat, lon){
  for (const d of DEPT_POLYS)
    if (d.polys.some(p=>inRing(lon, lat, p[0]))) return d.nombre;
  // Islas y orillas del Titicaca quedan fuera del borde simplificado:
  // se asignan al departamento más cercano.
  let best = null, bestKm = MAX_KM;
  for (const d of DEPT_POLYS) for (const p of d.polys){
    const km = ringDistKm(lat, lon, p[0]);
    if (km < bestKm){ bestKm = km; best = d.nombre; }
  }
  return best;
}

/* ---------- Principal ---------- */
function conservar(motivo){
  // ::warning:: queda como aviso en el resumen de GitHub Actions sin marcar la ejecución como fallida.
  console.log(`::warning::${motivo}. Se conserva data/museos.geojson; se reintentará en la próxima ejecución.`);
  process.exit(0);
}

let datos;
if (process.argv[2]) datos = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
else {
  try{ datos = await consultarOverpass(); }
  catch(e){ conservar(e.message); }
}

const features = [];
for (const el of datos.elements){
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat==null || lon==null) continue;
  const departamento = asignarDepartamento(lat, lon);
  if (!departamento){ console.warn(`Descartado (fuera de Bolivia): ${el.type}/${el.id} ${el.tags?.name||''}`); continue; }
  features.push({
    type:'Feature',
    geometry:{type:'Point', coordinates:[+lon.toFixed(6), +lat.toFixed(6)]},
    properties:{osm_type:el.type, osm_id:el.id, departamento, ...el.tags},
  });
}
// Orden estable: el diff de git muestra solo los museos que cambiaron.
features.sort((a,b)=>(a.properties.osm_type+a.properties.osm_id).localeCompare(b.properties.osm_type+b.properties.osm_id, 'en', {numeric:true}));

const anterior = fs.existsSync(SALIDA) ? JSON.parse(fs.readFileSync(SALIDA, 'utf8')) : null;
if (anterior && features.length < anterior.features.length*MIN_PROPORCION)
  conservar(`Overpass devolvió solo ${features.length} museos (antes ${anterior.features.length})`);
if (anterior && JSON.stringify(anterior.features)===JSON.stringify(features)){
  console.log(`Sin cambios: ${features.length} museos`);
  process.exit(0);
}

const texto = '{"type":"FeatureCollection",\n'
  + `"actualizado":${JSON.stringify(new Date().toISOString())},\n`
  + '"fuente":"© OpenStreetMap contributors (ODbL), vía Overpass API",\n'
  + '"features":[\n' + features.map(f=>JSON.stringify(f)).join(',\n') + '\n]}\n';
fs.mkdirSync(path.dirname(SALIDA), {recursive:true});
fs.writeFileSync(SALIDA, texto);
console.log(`Escrito ${path.relative(RAIZ, SALIDA)}: ${features.length} museos`
  + (anterior ? ` (antes ${anterior.features.length})` : ''));
