// Local visual/playback acceptance harness; no model, microphone, or paid API calls.
import { createServer } from 'node:http'
import path from 'node:path'
import { SceneHost } from '../src/main/sceneHost.ts'
import { ensureBakedModel, verifyEmoteRuntime } from '../src/main/emoteBake.ts'
import { nodeBaker } from '../src/main/emoteBakeNode.ts'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '../resources')
const cache = await mkdtemp(path.join(os.tmpdir(), 'amadeus-scene-cache-'))
const emoteDir = existsSync(path.join(root, 'character/emote')) ? path.join(root, 'character/emote') : path.join(root, 'emote')
await verifyEmoteRuntime(emoteDir)
const baked = await ensureBakedModel('kurisu_ab_white', { baker: nodeBaker, modelRoot: path.join(emoteDir, 'models'), cacheDir: cache })
const scene = new SceneHost(root, path.resolve(import.meta.dirname, '../dist/scene'), cache)
await scene.start()
scene.setEmoteAssets(emoteDir, path.dirname(baked.psb))
const sceneUrl = existsSync(path.join(root, 'scene/stage/index.html')) ? '/scene/stage/index.html' : '/render/web/wallpaper_engine.html'
const html = `<!doctype html><html><body style="margin:0;background:#05070b"><iframe id="scene" allow="autoplay" src="${sceneUrl}?sceneLoadToken=acceptance" style="border:0;width:100vw;height:100vh"></iframe><script>
const frame = document.getElementById('scene'); let port; let generation=0;
window.events=[]; window.ready=false;
const key=()=>({sessionId:'acceptance',turnId:'turn-'+generation,generation});
window.sendVoice=(event)=>port.postMessage({...key(),...event});
window.begin=(speech=false)=>{generation++;sendVoice({type:'begin',speech,calibration:{mouthGain:8,silenceThreshold:.08,syncOffsetMs:0}})};
window.play=()=>{
 begin(true);
 sendVoice({type:'activity',activity:'thinking'});
 sendVoice({type:'text',value:{text:'Hello world',cues:[{offset:0,emotion:'smile'}]}});
 const pcm=new Uint8Array(24000*2*3), view=new DataView(pcm.buffer);
 for(let i=0;i<72000;i++)view.setInt16(i*2,Math.sin(i/24000*Math.PI*2*220)*2000,true);
 sendVoice({type:'audio',pcm,alignment:{chunk_seq:0,content:'Hello world',chunk_audio_offset_sec:0,alignment:{segments:[{text:'Hello',start:0,end:1},{text:'world',start:1,end:3}]}}});
 sendVoice({type:'activity',activity:'idle'});sendVoice({type:'input-ended'});
};
window.addEventListener('message',e=>{
 if(e.source!==frame.contentWindow||e.origin!==location.origin||e.data.sceneLoadToken!=='acceptance'||e.data.status!=='voice-ready')return;
 const channel=new MessageChannel();port=channel.port1;
 port.onmessage=e=>{events.push(e.data);if(e.data.type==='connected'){ready=true;begin()}};
 port.start();frame.contentWindow.postMessage({type:'amadeus.connect',sceneLoadToken:'acceptance'},location.origin,[channel.port2]);
});
</script></body></html>`
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
    const upstream = await fetch(scene.origin + request.url)
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' })
    if (request.url === '/next/init') response.end((await upstream.text()).replaceAll(scene.origin, ''))
    else response.end(Buffer.from(await upstream.arrayBuffer()))
  } catch { response.writeHead(500); response.end('Fixture error') }
})
server.listen(0, '127.0.0.1', () => console.log('Acceptance scene: http://127.0.0.1:' + server.address().port))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { scene.close(); server.closeAllConnections(); server.close(); await rm(cache, { recursive: true, force: true }); process.exit() })
