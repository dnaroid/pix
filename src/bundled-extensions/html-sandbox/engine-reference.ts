/** Offline authoring reference, shipped in the guide rather than workspace files. */
export const HTML_SANDBOX_ENGINE_REFERENCE = `## Animation and packaged engines

Choose the smallest tool that fits: CSS/SVG for simple motion, Canvas + requestAnimationFrame for small 2D sketches, **Phaser 3.90.0** for 2D games/scenes/physics, **Three.js 0.186.1** (r186, core only) for 3D/WebGL. Phaser is not Photon: networking/multiplayer services are not available.

Opt in with an empty classic script declaration inside the same pix-html block:
- \`<script src="pix:phaser"></script>\` makes global \`Phaser\` available.
- \`<script src="pix:three"></script>\` makes global \`THREE\` available.

These are Pix markers, not URLs to fetch. Pix lazily loads the pinned, locally packaged engine on Run and installs it before your scripts inside the isolated iframe. Do not paste engine source, use npm imports, change versions, add async/type/module attributes to the marker, or load CDN scripts. Both engines may be requested but prefer only the one needed. No Three.js addons (OrbitControls, GLTFLoader, etc.) or Phaser plugins are bundled. Engine bytes do not count toward the 200,000-character authored-source limit. The same network/CSP limits still apply: use procedural geometry, drawn textures, inline data images/audio; asset loaders cannot fetch remote or workspace files. Do not use eval/new Function. Three.js requires WebGL2; catch renderer creation failure and show a visible fallback, rather than claiming every device supports 3D. Phaser.CANVAS is a reliable 2D fallback. WebGPU/XR are not promised.

### Phaser: offline 2D animation with a click target

Place this entire example in one pix-html fence. The scene uses no downloaded assets:

\`\`\`html
<style>body{margin:0}#game{width:100%;height:320px}canvas{display:block;max-width:100%}</style>
<div id="game"></div>
<script src="pix:phaser"></script>
<script>
const game = new Phaser.Game({
  type: Phaser.CANVAS, parent: 'game', width: 640, height: 320,
  backgroundColor: '#182332', audio: { noAudio: true },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: { create() {
    const label = this.add.text(16, 16, 'Click the moving circle', { fontSize: '20px' });
    const target = this.add.circle(80, 165, 28, 0x58c4dc).setInteractive();
    let score = 0;
    target.on('pointerdown', () => label.setText('Score: ' + (++score)));
    this.tweens.add({ targets: target, x: 560, duration: 1400, yoyo: true, repeat: -1 });
  } }
});
window.addEventListener('pagehide', () => game.destroy(true), { once: true });
</script>
\`\`\`

### Three.js: responsive rotating cube, with a WebGL fallback

Place this entire example in one pix-html fence; no module imports are necessary:

\`\`\`html
<style>body{margin:0}#view{width:100%;height:320px}canvas{display:block;max-width:100%}</style>
<div id="view"></div>
<script src="pix:three"></script>
<script>
const host = document.querySelector('#view');
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
catch { host.textContent = 'WebGL2 is unavailable. Try a Canvas 2D version.'; }
if (renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.z = 3;
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshNormalMaterial();
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const resize = new ResizeObserver(() => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  renderer.setAnimationLoop(time => {
    cube.rotation.x = time / 1800; cube.rotation.y = time / 1200;
    renderer.render(scene, camera);
  });
  window.addEventListener('pagehide', () => {
    resize.disconnect(); renderer.setAnimationLoop(null);
    geometry.dispose(); material.dispose(); renderer.dispose();
  }, { once: true });
}
</script>
\`\`\`

Stop/Restart removes the entire guest iframe. Within a running demo, release old scenes, listeners, timers, animation loops and GPU resources when replacing them. Avoid huge meshes/textures and busy loops; isolation does not impose hard CPU/GPU/memory quotas.

API references (for authoring, never runtime imports): Phaser 3: https://docs.phaser.io/api-documentation/api-documentation ; Three.js: https://threejs.org/docs/ . Use the pinned versions above, not Phaser 4 or unbundled Three.js addon examples.`;
