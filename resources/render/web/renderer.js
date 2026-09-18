/**
 * renderer.js — PixiJS render engine core
 *
 * SpriteRenderer is the low-level Pixi frame / mouth / texture driver.
 * The character state machine lives in TypeScript (src/shared/character.ts,
 * driven by src/scene/index.ts) and is injected through
 * window.__SALIERI_CHARACTER_FACTORY__; this file no longer carries a JS
 * fallback state machine.
 *
 * Exposes window.renderApp for the scene adapter in wallpaper_scene.js:
 *   renderApp.getPixiApp()
 *   renderApp.setSpriteViewportBounds(bounds)
 *   renderApp.setSpriteViewportMask(mask)
 *   renderApp._sprite   (read by the readiness probe in wallpaper_engine.html)
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // PixiJS Application
  // ---------------------------------------------------------------------------
  const app = new PIXI.Application({
    resizeTo: document.getElementById("canvas-container"),
    backgroundAlpha: 0,          // Transparent background
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    antialias: true,
  });
  document.getElementById("canvas-container").appendChild(app.view);

  // ---------------------------------------------------------------------------
  // SpriteRenderer — deprecated foreground sprite path kept for existing assets.
  // ---------------------------------------------------------------------------
  class SpriteRenderer {
    constructor(stage) {
      this.stage = stage;
      this.container = new PIXI.Container();
      stage.addChild(this.container);

      this.sprite = new PIXI.Sprite();
      this.sprite.anchor.set(0.5, 1.0);  // Bottom-center alignment
      this.container.addChild(this.sprite);

      /** emotion → PIXI.Texture[] */
      this._frames = {};
      this._frameUrls = {};
      this._texturePromisesByUrl = new Map();
      this._compressedTextureRuntimePromise = null;
      this._compressedTextureRuntimeReady = false;
      this._framePromises = {};
      this._frameSetStates = {};
      this._frameLoadQueue = new Map();
      this._frameLoadSerial = 0;
      this._activeFrameSetLoads = 0;
      this._maxConcurrentFrameSetLoads = 1;
      this._frameLoadPumpTimer = null;
      this._lastSpeechStateChangedAt = 0;
      this._framesPerLoadSlice = 2;
      this._speechQuietBeforeSpeculativeMs = 900;
      this._speculativeLoadEpoch = 0;
      this._pinnedFrameLabels = new Set([
        "idle",
        "speaking_short",
        "speaking_med",
        "speaking_long",
        "speaking_trans",
        "speaking_loop1",
        "speaking_loop2",
        "closed_eye_trans",
        "speaking_closed_eye_1",
        "speaking_closed_eye_2",
        "smile_speaking",
        "sad_speaking",
        "shy_speaking1",
        "shy_speaking2",
        "surprise_speaking",
        "angry_speaking",
      ]);
      this._warmFrameLabels = new Set([
        "thinking_trans",
        "thinking_speaking1",
        "thinking_speaking2",
        "thinking_to_serious",
        "thinking_to_key_point",
        "key_point_speaking",
        "serious_to_thinking",
      ]);
      /** emotion → PIXI.Texture[][] (transition from→to) */
      this._transitions = {};

      this._currentEmotion = "normal";
      this._speaking = false;
      this._mouthValue = 0;
      this._frameIdx = 0;
      this._ticker = null;
      this._transitionQueue = [];  // Transition frame sequence currently playing
      this._frameIntervals = {};   // emotion → ms
      this._clipConfigs = {};      // emotion → {loopMode, frameIntervalMs}
      this._idleAnimationEnabled = true;
      this._held = false;          // frame hold active
      this._heldFrameIdx = 0;      // idx saved during hold
      this._cycleCompleteHandler = null;
      this._cycleCompletedForEmotion = "";
      this._mouthTextures = {};
      this._mouthConfigSignatures = {};
      this._activeFrameIdx = 0;
      this._activeFramePhase = "frames";
      this._mouthSourceAnchor = null;
      this._viewportBounds = null;

      this._mouthMask = new PIXI.Graphics();
      this.sprite.addChild(this._mouthMask);

      this._mouthOverlay = new PIXI.Sprite();
      this._mouthOverlay.anchor.set(0.5, 1.0);
      this._mouthOverlay.x = 0;
      this._mouthOverlay.y = 0;
      this._mouthOverlay.visible = false;
      this._mouthOverlay.mask = this._mouthMask;
      this.sprite.addChild(this._mouthOverlay);
      this._mouthConfigs = {};     // label → js_cfg

      this._startIdleTicker();
    }

    // ---- Asset loading ----

    loadFrames(emotion, urls) {
      if (this._sameUrlList(this._frameUrls[emotion], urls) && this._frames[emotion]) {
        return;
      }
      this._frameUrls[emotion] = Array.isArray(urls) ? urls.slice() : [];
      console.log("[SpriteRenderer] registerFrames:", emotion, urls.length, "urls, first:", (urls[0]||'').slice(0, 100));
      const textures = new Array(urls.length);
      this._frames[emotion] = textures;
      this._framePromises[emotion] = new Array(urls.length);
      this._frameSetStates[emotion] = "cold";

      // Poster frame keeps low-frequency graph hops from flashing blank while
      // the full clip is still cold. The rest of the clip is loaded by the
      // priority scheduler below.
      this._ensureFrameIndex(emotion, 0);

      const priority = this._initialFrameSetPriority(emotion);
      if (priority > 0) {
        this._queueFrameSet(emotion, priority, { reason: "register" });
      }
    }

    loadTransitionFrames(fromEmotion, toEmotion, urls) {
      const key = `${fromEmotion}->${toEmotion}`;
      const textures = new Array(urls.length);
      this._transitions[key] = textures;
      let loaded = 0;
      urls.forEach((u, idx) => {
        this._loadTextureFromImage(u).then((tex) => {
          if (!tex) return;
          textures[idx] = tex;
          loaded++;
          if (loaded === urls.length) {
            console.log("[SpriteRenderer] transition ready:", key, loaded);
          }
        });
      });
    }

    // ---- State control ----

    setEmotion(emotion) {
      if (emotion === this._currentEmotion) return;
      const key = `${this._currentEmotion}->${emotion}`;
      const transFrames = this._transitions[key];
      const prev = this._currentEmotion;
      console.log("[SpriteRenderer] setEmotion: %s → %s (transition=%s, hasFrames=%s)",
        prev, emotion, key in this._transitions, !!this._frames[emotion]);
      this._currentEmotion = emotion;
      this._frameIdx = 0;
      this._cycleCompletedForEmotion = "";
      this._hideMouthLayer();
      this._queueFrameSet(emotion, this._currentFrameSetPriority(emotion), { reason: "current" });

      if (transFrames && transFrames.length > 0) {
        this._playTransition(transFrames, () => this._showFrame(0));
      } else {
        this._showFrame(0);
      }
    }

    setSpeaking(speaking) {
      if (this._speaking === speaking) return;
      this._speaking = speaking;
      this._lastSpeechStateChangedAt = Date.now();
      if (speaking) {
        this.clearSpeculativeFrameLoads();
      } else {
        this._scheduleFrameLoadPump(320);
      }
      if (speaking) {
        this._frameIdx = 0;
        this._cycleCompletedForEmotion = "";
        this._held = false;
      }
      this._updateMouthLayer();
    }

    setMouth(value) {
      this._mouthValue = Math.max(0, Math.min(1, value));
      this._updateMouthLayer();
    }

    setIdleAnimation(enabled) {
      this._idleAnimationEnabled = enabled;
    }

    setIdleFrameIntervalMs(emotion, intervalMs) {
      this._frameIntervals[emotion] = intervalMs;
    }

    setClipConfig(emotion, config) {
      this._clipConfigs[emotion] = config;
    }

    setCycleCompleteHandler(handler) {
      this._cycleCompleteHandler = handler;
    }

    loadMouthConfig(label, config) {
      const signature = JSON.stringify(config || {});
      if (this._mouthConfigSignatures[label] === signature && this._mouthTextures[label]) {
        return;
      }
      this._mouthConfigSignatures[label] = signature;
      this._mouthConfigs[label] = config;
      const urls = Array.isArray(config.frameUrls) ? config.frameUrls : [];
      const textures = new Array(urls.length);
      this._mouthTextures[label] = textures;
      urls.forEach((u, idx) => {
        this._loadTextureFromImage(u).then((tex) => {
          if (!tex) return;
          textures[idx] = tex;
          if (label === this._currentEmotion) {
            this._updateMouthLayer();
          }
        });
      });
      console.log("[SpriteRenderer] mouth config for", label, JSON.stringify(config).slice(0, 120));
    }

    _sameUrlList(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    prefetchLabels(labels, priority = "interactive", options = {}) {
      const score = this._priorityScore(priority);
      if (!score) return;
      for (const label of labels || []) {
        const emotion = String(label || "").trim();
        if (!emotion) continue;
        this._queueFrameSet(emotion, score, {
          reason: options.reason || priority,
          speculative: !!options.speculative,
        });
      }
    }

    clearSpeculativeFrameLoads() {
      let cleared = 0;
      this._speculativeLoadEpoch += 1;
      for (const [label, entry] of Array.from(this._frameLoadQueue.entries())) {
        if (entry && entry.speculative) {
          this._frameLoadQueue.delete(label);
          cleared += 1;
        }
      }
      if (cleared > 0) {
        console.log("[SpriteRenderer] cleared speculative frame loads:", cleared);
      }
    }

    _initialFrameSetPriority(emotion) {
      if (this._pinnedFrameLabels.has(emotion)) return 100;
      if (this._warmFrameLabels.has(emotion)) return 65;
      return 0;
    }

    _currentFrameSetPriority(emotion) {
      if (this._pinnedFrameLabels.has(emotion)) return 100;
      if (this._warmFrameLabels.has(emotion)) return 90;
      if (/speaking|trans|thinking|key_point/.test(String(emotion || ""))) return 90;
      return 65;
    }

    _priorityScore(priority) {
      if (typeof priority === "number") return priority;
      if (priority === "pinned" || priority === "current") return 100;
      if (priority === "interactive") return 90;
      if (priority === "speaking") return 85;
      if (priority === "warm") return 65;
      if (priority === "ambient") return 25;
      if (priority === "poster") return 10;
      return 0;
    }

    _queueFrameSet(emotion, priority, options = {}) {
      if (!emotion || !this._frameUrls[emotion] || !this._frameUrls[emotion].length) return;
      const currentState = this._frameSetStates[emotion];
      if (currentState === "warm" && priority < 100) return;
      const existing = this._frameLoadQueue.get(emotion);
      const next = {
        priority: Math.max(priority, existing ? existing.priority : 0),
        serial: existing ? existing.serial : ++this._frameLoadSerial,
        speculative: !!(options.speculative || (existing && existing.speculative)),
        speculativeEpoch: options.speculative ? this._speculativeLoadEpoch : (existing && existing.speculativeEpoch) || this._speculativeLoadEpoch,
        reason: options.reason || (existing && existing.reason) || "",
      };
      this._frameLoadQueue.set(emotion, next);
      this._scheduleFrameLoadPump(0);
    }

    _scheduleFrameLoadPump(delayMs = 0) {
      if (this._frameLoadPumpTimer) return;
      this._frameLoadPumpTimer = setTimeout(() => {
        this._frameLoadPumpTimer = null;
        this._pumpFrameLoadQueue();
      }, Math.max(0, delayMs));
    }

    _pumpFrameLoadQueue() {
      while (this._activeFrameSetLoads < this._maxConcurrentFrameSetLoads && this._frameLoadQueue.size > 0) {
        let selectedLabel = "";
        let selectedEntry = null;
        for (const [label, entry] of this._frameLoadQueue.entries()) {
          if (this._shouldDeferFrameSet(entry)) continue;
          if (
            !selectedEntry ||
            entry.priority > selectedEntry.priority ||
            (entry.priority === selectedEntry.priority && entry.serial < selectedEntry.serial)
          ) {
            selectedLabel = label;
            selectedEntry = entry;
          }
        }
        if (!selectedLabel) {
          this._scheduleFrameLoadPump(360);
          return;
        }
        this._frameLoadQueue.delete(selectedLabel);
        this._activeFrameSetLoads += 1;
        this._loadFrameSet(selectedLabel, selectedEntry).finally(() => {
          this._activeFrameSetLoads = Math.max(0, this._activeFrameSetLoads - 1);
          this._scheduleFrameLoadPump(0);
        });
      }
    }

    _shouldDeferFrameSet(entry) {
      if (!entry) return false;
      if (entry.priority >= 90) return false;
      if (this._speaking) return true;
      const quietMs = Date.now() - this._lastSpeechStateChangedAt;
      return quietMs < this._speechQuietBeforeSpeculativeMs;
    }

    async _loadFrameSet(emotion, entry) {
      const urls = this._frameUrls[emotion] || [];
      if (!urls.length) return;
      this._frameSetStates[emotion] = "loading";
      console.log("[SpriteRenderer] frame load start:", emotion, urls.length, entry && entry.reason ? entry.reason : "");
      let loadedThisSlice = 0;
      for (let i = 0; i < urls.length; i += 1) {
        if (entry && entry.speculative && entry.speculativeEpoch !== this._speculativeLoadEpoch) {
          this._frameSetStates[emotion] = "cold";
          return;
        }
        if (this._shouldDeferFrameSet(entry)) {
          this._frameSetStates[emotion] = "cold";
          this._queueFrameSet(emotion, entry.priority, entry);
          return;
        }
        await this._ensureFrameIndex(emotion, i);
        loadedThisSlice += 1;
        if (loadedThisSlice >= this._framesPerLoadSlice) {
          loadedThisSlice = 0;
          await this._yieldFrameLoadSlice(entry);
        }
      }
      this._frameSetStates[emotion] = "warm";
      console.log("[SpriteRenderer] frame load ready:", emotion, urls.length);
    }

    _yieldFrameLoadSlice(entry) {
      const delay = this._speaking ? 16 : (entry && entry.priority >= 90 ? 0 : 24);
      if (typeof requestIdleCallback === "function" && (!entry || entry.priority < 90) && !this._speaking) {
        return new Promise((resolve) => requestIdleCallback(resolve, { timeout: 80 }));
      }
      return new Promise((resolve) => setTimeout(resolve, delay));
    }

    _ensureFrameIndex(emotion, idx) {
      const urls = this._frameUrls[emotion] || [];
      const textures = this._frames[emotion] || [];
      if (!urls.length || idx < 0 || idx >= urls.length) return Promise.resolve(null);
      if (textures[idx]) return Promise.resolve(textures[idx]);
      if (!this._framePromises[emotion]) this._framePromises[emotion] = new Array(urls.length);
      if (this._framePromises[emotion][idx]) return this._framePromises[emotion][idx];

      const promise = this._loadTextureFromImage(urls[idx]).then((tex) => {
        if (tex) {
          textures[idx] = tex;
          if (emotion === this._currentEmotion && idx === this._frameIdx) {
            this._showFrame(idx);
          }
        }
        return tex;
      }).finally(() => {
        if (this._framePromises[emotion]) this._framePromises[emotion][idx] = null;
      });
      this._framePromises[emotion][idx] = promise;
      return promise;
    }

    holdFrame(which) {
      if (which === undefined || which === null) {
        this._heldFrameIdx = this._frameIdx; // hold current
      } else if (which === -1) {
        const frames = this._getEmotionFrames();
        this._heldFrameIdx = frames ? frames.length - 1 : this._frameIdx; // hold last
      } else {
        this._heldFrameIdx = which;
      }
      this._held = true;
      this._activeFramePhase = "frames";
      this._activeFrameIdx = this._heldFrameIdx;
      this._showFrame(this._heldFrameIdx);
    }

    holdClosedFrame() {
      const frames = this._getEmotionFrames();
      if (!frames || frames.length === 0) {
        this.holdFrame(null);
        return;
      }
      const cfg = this._mouthConfigs[this._currentEmotion] || {};
      let idx = Number.isFinite(cfg.closedFrameIdx) ? Math.round(cfg.closedFrameIdx) : NaN;
      const openness = Array.isArray(cfg.opennessByFrame) ? cfg.opennessByFrame : [];
      if (openness.length) {
        let bestIdx = -1;
        let bestValue = Infinity;
        const n = Math.min(openness.length, frames.length);
        for (let i = 0; i < n; i += 1) {
          const value = Number(openness[i]);
          if (!Number.isFinite(value)) continue;
          if (value < bestValue && frames[i]) {
            bestValue = value;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) idx = bestIdx;
      }
      if (!Number.isFinite(idx)) idx = this._frameIdx;
      this.holdFrame(Math.max(0, Math.min(frames.length - 1, idx)));
    }

    clearHold() {
      this._held = false;
    }

    resize(w, h) {
      this._applyCurrentTransform();
    }

    // ---- Internals ----

    setViewportBounds(bounds) {
      if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
        this._viewportBounds = null;
      } else {
        this._viewportBounds = {
          x: Number(bounds.x),
          y: Number(bounds.y),
          width: Math.max(1, Number(bounds.width)),
          height: Math.max(1, Number(bounds.height)),
        };
        this._viewportBounds.right = this._viewportBounds.x + this._viewportBounds.width;
        this._viewportBounds.bottom = this._viewportBounds.y + this._viewportBounds.height;
      }
      this._applyCurrentTransform();
    }

    _getEmotionFrames() {
      return this._frames[this._currentEmotion] || this._frames["normal"] || null;
    }

    _showFrame(idx) {
      const frames = this._getEmotionFrames();
      if (!frames || frames.length === 0) return;
      const targetIdx = idx % frames.length;
      let texture = frames[targetIdx];
      if (!texture) {
        // file:// assets are decoded asynchronously. Falling back to the first
        // loaded frame creates visible mid-animation snaps; keep the previous
        // frame until the requested texture is ready.
        const hasCurrentTexture = this.sprite.texture && this.sprite.texture.height > 1;
        if (hasCurrentTexture) return;
        texture = frames.find(Boolean);
      }
      if (!texture) return;
      this._frameIdx = targetIdx;
      this._activeFramePhase = "frames";
      this._activeFrameIdx = targetIdx;
      this._applyFrame(texture);
    }

    _loadTextureFromImage(url) {
      const key = String(url || "");
      if (!key) return Promise.resolve(null);

      const cached = this._texturePromisesByUrl.get(key);
      if (cached) {
        return cached.then((texture) => {
          if (texture && !texture.destroyed && texture.baseTexture && !texture.baseTexture.destroyed) {
            return texture;
          }
          this._texturePromisesByUrl.delete(key);
          return this._loadTextureFromImage(key);
        });
      }

      const loadPromise = this._isKtx2Url(key)
        ? this._loadTextureFromCompressedAsset(key)
        : this._loadTextureFromRasterImage(key);

      this._texturePromisesByUrl.set(key, loadPromise);
      return loadPromise;
    }

    _isKtx2Url(url) {
      return /\.ktx2(?:[?#]|$)/i.test(String(url || ""));
    }

    _pngFallbackUrl(url) {
      const key = String(url || "");
      if (!this._isKtx2Url(key)) return "";
      return key
        .replace(/(frames[^/?#]*?)_ktx2_uastc_q\d+_z\d+(?=[/\\])/i, "$1")
        .replace(/\.ktx2(?=([?#]|$))/i, ".png");
    }

    _loadTextureFromRasterImage(key) {
      return new Promise((resolve) => {
        const img = new Image();
        img.decoding = "async";
        if (/^https?:\/\//i.test(key)) {
          img.crossOrigin = "anonymous";
        }
        img.onload = async () => {
          try {
            if (typeof img.decode === "function") {
              try {
                await img.decode();
              } catch (_) {
                // onload already fired; some Chromium/file:// paths reject decode().
              }
            }
            const tex = PIXI.Texture.from(img);
            if (tex.baseTexture && typeof tex.baseTexture.update === "function") {
              tex.baseTexture.update();
            }
            await this._prepareTexture(tex);
            resolve(tex);
          } catch (e) {
            console.error("[SpriteRenderer] Texture.from failed:", key.slice(0, 160), e);
            resolve(null);
          }
        };
        img.onerror = () => {
          console.error("[SpriteRenderer] IMG FAIL:", key.slice(0, 160));
          resolve(null);
        };
        img.src = key;
      }).then((texture) => {
        if (!texture) {
          this._texturePromisesByUrl.delete(key);
        }
        return texture;
      });
    }

    async _ensureCompressedTextureRuntime() {
      if (this._compressedTextureRuntimeReady) return true;
      if (this._compressedTextureRuntimePromise) {
        return this._compressedTextureRuntimePromise;
      }
      this._compressedTextureRuntimePromise = (async () => {
        if (!window.PixiBasisKtx2Shim || !PIXI.Assets) {
          console.warn("[SpriteRenderer] KTX2 loader unavailable; falling back to PNG");
          return false;
        }
        try {
          await PixiBasisKtx2Shim.KTX2Parser.loadTranscoder(
            "./vendor/basis_transcoder.js",
            "./vendor/basis_transcoder.wasm"
          );
          await PIXI.Assets.init({
            texturePreference: { format: ["ktx2", "ktx", "png"] },
          });
          this._compressedTextureRuntimeReady = true;
          console.log("[SpriteRenderer] KTX2 compressed texture runtime ready");
          return true;
        } catch (e) {
          console.warn("[SpriteRenderer] KTX2 runtime init failed; falling back to PNG", e);
          return false;
        }
      })();
      return this._compressedTextureRuntimePromise;
    }

    async _loadTextureFromCompressedAsset(key) {
      if (!(await this._ensureCompressedTextureRuntime())) {
        const fallback = this._pngFallbackUrl(key);
        return fallback ? this._loadTextureFromImage(fallback) : null;
      }
      try {
        const loaded = await PIXI.Assets.load({
          src: key,
          format: "ktx2",
          loadParser: "loadKTX2",
        });
        const texture = Array.isArray(loaded) ? loaded[0] : loaded;
        if (!texture) throw new Error("PIXI.Assets.load returned no texture");
        const tex = texture.baseTexture ? texture : new PIXI.Texture(texture);
        await this._prepareTexture(tex);
        return tex;
      } catch (e) {
        console.warn("[SpriteRenderer] KTX2 load failed, trying PNG fallback:", key.slice(0, 160), e);
        this._texturePromisesByUrl.delete(key);
        const fallback = this._pngFallbackUrl(key);
        return fallback ? this._loadTextureFromImage(fallback) : null;
      }
    }

    _prepareTexture(texture) {
      return new Promise((resolve) => {
        const prepare = app.renderer && app.renderer.plugins && app.renderer.plugins.prepare;
        if (!prepare || typeof prepare.upload !== "function") {
          resolve();
          return;
        }
        try {
          prepare.upload(texture, resolve);
        } catch (_) {
          resolve();
        }
      });
    }

    _applyFrame(texture) {
      if (!texture) return;
      this.sprite.texture = texture;
      this._applyCurrentTransform();
      this._updateMouthLayer();
    }

    _applyCurrentTransform() {
      const texture = this.sprite.texture;
      if (!texture || texture.height <= 1) {
        this.sprite.scale.set(1);
        return;
      }
      if (this._viewportBounds) {
        const b = this._viewportBounds;
        const maxW = b.width * 0.64;
        const maxH = b.height * 0.90;
        const scale = Math.min(maxW / texture.width, maxH / texture.height);
        this.sprite.scale.set(scale);
        this.sprite.x = b.x + b.width * 0.52;
        this.sprite.y = b.bottom + b.height * 0.05;
        return;
      }
      const h = app.screen.height;
      const scale = h / texture.height;
      this.sprite.scale.set(scale);
      this.sprite.x = app.screen.width / 2;
      this.sprite.y = h;
    }

    _hideMouthLayer() {
      if (this._mouthOverlay) {
        this._mouthOverlay.visible = false;
        this._mouthOverlay.x = 0;
        this._mouthOverlay.y = 0;
      }
      this._mouthSourceAnchor = null;
      if (this._mouthMask) this._mouthMask.clear();
    }

    _updateMouthLayer() {
      const cfg = this._mouthConfigs[this._currentEmotion];
      const textures = this._mouthTextures[this._currentEmotion] || [];
      if (!cfg || !textures.length) {
        this._hideMouthLayer();
        return;
      }

      const openness = Array.isArray(cfg.openness) ? cfg.openness : [];
      const n = Math.min(openness.length || textures.length, textures.length);
      if (n <= 0) {
        this._hideMouthLayer();
        return;
      }

      let bestIdx = 0;
      let bestDist = Infinity;
      const mode = cfg.mode || "full_map";
      const silenceClose = mode === "silence_close";
      const targetValue = silenceClose ? 0.0 : this._mouthValue;
      for (let i = 0; i < n; i++) {
        const level = typeof openness[i] === "number" ? openness[i] : (i / Math.max(1, n - 1));
        const dist = Math.abs(level - targetValue);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      const texture = textures[bestIdx];
      if (!this._isTextureReady(texture)) {
        this._hideMouthLayer();
        return;
      }

      this._mouthOverlay.texture = texture;
      const sourceAnchors = Array.isArray(cfg.sourceAnchors) ? cfg.sourceAnchors : null;
      this._mouthSourceAnchor = sourceAnchors && sourceAnchors[bestIdx] ? sourceAnchors[bestIdx] : null;

      if (silenceClose) {
        const threshold = Number.isFinite(cfg.silenceThreshold) ? cfg.silenceThreshold : 0.08;
        const shouldClose = !this._speaking || this._mouthValue <= threshold;
        this._mouthOverlay.visible = shouldClose;
        if (shouldClose) {
          const maskAmp = Number.isFinite(cfg.silenceMaskAmplitude) ? cfg.silenceMaskAmplitude : 0.75;
          this._drawMouthMask(maskAmp, cfg);
        } else {
          this._hideMouthLayer();
        }
        return;
      }

      if (this._speaking) {
        this._mouthOverlay.visible = true;
        this._drawMouthMask(Math.max(this._mouthValue, 0.05), cfg);
      } else {
        this._mouthOverlay.visible = this._mouthValue > 0.01;
        if (this._mouthValue > 0.01) {
          this._drawMouthMask(Math.max(this._mouthValue, 0.05), cfg);
        } else {
          this._hideMouthLayer();
        }
      }
    }

    _isTextureReady(texture) {
      return !!(
        texture &&
        !texture.destroyed &&
        texture.baseTexture &&
        !texture.baseTexture.destroyed &&
        texture.baseTexture.valid &&
        Number.isFinite(texture.width) &&
        Number.isFinite(texture.height) &&
        texture.width > 1 &&
        texture.height > 1
      );
    }

    _textureHeight(texture, fallback = 1) {
      if (!this._isTextureReady(texture)) return fallback;
      return Number.isFinite(texture.height) && texture.height > 1 ? texture.height : fallback;
    }

    _drawMouthMask(amplitude, cfg) {
      const g = this._mouthMask;
      g.clear();
      if (amplitude <= 0) return;
      const tex = this.sprite.texture;
      const th = this._textureHeight(tex, 1);
      if (th <= 1) return;

      const anchor = this._getMouthAnchor(cfg);
      const cx = Number.isFinite(anchor.cx) ? anchor.cx : cfg.cx;
      const cy = Number.isFinite(anchor.cy) ? anchor.cy : cfg.cy;
      const width = Number.isFinite(anchor.width) ? anchor.width : cfg.width;
      const height = Number.isFinite(anchor.height) ? anchor.height : cfg.height;
      const maskWidthMul = Number.isFinite(cfg.maskWidthMul) ? cfg.maskWidthMul : 1.0;
      const maskHeightMul = Number.isFinite(cfg.maskHeightMul) ? cfg.maskHeightMul : 1.0;
      const maskCyOffset = Number.isFinite(cfg.maskCyOffset) ? cfg.maskCyOffset : 0.0;
      const overlayH = this._textureHeight(this._mouthOverlay.texture, th);

      const localX = cx;
      const localY = cy - th / 2;
      const maskLocalY = localY + maskCyOffset;
      const source = this._mouthSourceAnchor || {};
      const sourceCx = Number.isFinite(source.cx)
        ? source.cx
        : (Number.isFinite(cfg.sourceCx) ? cfg.sourceCx : (Number.isFinite(cfg.cx) ? cfg.cx : 0));
      const sourceCy = Number.isFinite(source.cy)
        ? source.cy
        : (Number.isFinite(cfg.sourceCy) ? cfg.sourceCy : (Number.isFinite(cfg.cy) ? cfg.cy : 0));
      if (cfg.overlayAlign === "canvas") {
        this._mouthOverlay.x = 0;
        this._mouthOverlay.y = 0;
      } else {
        this._mouthOverlay.x = localX - sourceCx;
        this._mouthOverlay.y = localY - (sourceCy - overlayH / 2);
      }

      const wHalf = (Math.max(1, width) / 2) * 1.8 * maskWidthMul;
      const hHalf = (Math.max(1, height) / 2) * (1.0 + 1.5 * amplitude) * maskHeightMul;
      if (hHalf < 0.5) return;

      g.beginFill(0xFFFFFF, 1);
      g.drawEllipse(localX, maskLocalY, wHalf, hHalf);
      g.endFill();
    }

    _getMouthAnchor(cfg) {
      const track = Array.isArray(cfg.anchorTrack) ? cfg.anchorTrack : [];
      if (track.length > 0) {
        const rawIdx = Number.isFinite(this._activeFrameIdx) ? this._activeFrameIdx : this._frameIdx;
        const idx = Math.max(0, Math.min(track.length - 1, Math.round(rawIdx)));
        const anchor = track[idx];
        if (anchor && typeof anchor === "object") {
          return {
            cx: Number.isFinite(anchor.cx) ? anchor.cx : cfg.cx,
            cy: Number.isFinite(anchor.cy) ? anchor.cy : cfg.cy,
            width: Number.isFinite(anchor.width) ? anchor.width : cfg.width,
            height: Number.isFinite(anchor.height) ? anchor.height : cfg.height,
          };
        }
      }
      return cfg || {};
    }

    _startIdleTicker() {
      // Uses per-emotion frame intervals when available (SpriteForge), falls back to 150ms.
      let elapsed = 0;
      let lastEmotion = null;
      let silentGuardHit = 0;
      let tickCount = 0;
      app.ticker.add((delta) => {
        tickCount++;
        if (tickCount % 180 === 1) {  // ~every 3s at 60fps
          console.log("[SpriteRenderer] ticker alive: tick=%d, iAE=%s, held=%s, tq=%d, emo=%s, fidx=%d, intv=%d, deltaMS=%d",
            tickCount, this._idleAnimationEnabled, this._held, this._transitionQueue.length,
            this._currentEmotion, this._frameIdx,
            this._frameIntervals[this._currentEmotion] || (this._clipConfigs[this._currentEmotion] && this._clipConfigs[this._currentEmotion].frameIntervalMs) || 150,
            Math.round(app.ticker.deltaMS));
        }

        if (!this._idleAnimationEnabled) { silentGuardHit++; return; }
        if (this._held) return;
        if (this._transitionQueue.length > 0) return;

        const frames = this._getEmotionFrames();
        if (!frames || frames.length === 0 || !frames.some(Boolean)) {
          silentGuardHit++;
          if (silentGuardHit === 60) {
            console.log("[SpriteRenderer] no frames for emotion: %s, keys: %s",
              this._currentEmotion, Object.keys(this._frames).join(','));
          }
          return;
        }
        silentGuardHit = 0;

        const emotion = this._currentEmotion;
        if (emotion !== lastEmotion) {
          elapsed = 0;
          lastEmotion = emotion;
        }
        const cfg = this._clipConfigs[emotion];
        const onceThenHold = cfg && cfg.loopMode === "once_then_hold";
        const mouthCfg = this._mouthConfigs[emotion];
        const interval = this._frameIntervals[emotion] || (cfg && cfg.frameIntervalMs) || 150;

        elapsed += Math.min(app.ticker.deltaMS, 100);
        if (elapsed < interval) return;
        const steps = Math.min(4, Math.floor(elapsed / interval));
        elapsed -= steps * interval;

        let advanced = false;
        let completedCycle = false;
        for (let i = 0; i < steps; i++) {
          if (onceThenHold && this._frameIdx >= frames.length - 1) {
            break;
          }

          const previousFrame = this._frameIdx;
          if (onceThenHold) {
            this._frameIdx = Math.min(this._frameIdx + 1, frames.length - 1);
          } else if (this._speaking && mouthCfg && frames.length > 1) {
            this._frameIdx = (this._frameIdx + 1) % frames.length;
          } else if (this._speaking && frames.length > 1) {
            this._frameIdx = (this._frameIdx % (frames.length - 1)) + 1;
          } else {
            this._frameIdx = (this._frameIdx + 1) % frames.length;
          }
          if (!onceThenHold && this._frameIdx < previousFrame) completedCycle = true;
          advanced = true;
        }

        if (!advanced) {
          return;
        }

        this._showFrame(this._frameIdx);
        if (onceThenHold && this._frameIdx >= frames.length - 1) {
          this._notifyCycleComplete(emotion);
        } else if (!onceThenHold && completedCycle) {
          this._notifyCycleComplete(emotion);
        } else {
          this._cycleCompletedForEmotion = "";
        }
        if (this._frameIdx === 0) {
          console.log("[SpriteRenderer] looping: emotion=%s frames=%d interval=%d",
            emotion, frames.length, interval);
        }
      });

      console.log("[SpriteRenderer] idle ticker started");
    }

    _notifyCycleComplete(emotion) {
      if (!this._cycleCompleteHandler) return;
      if (this._cycleCompletedForEmotion === emotion) return;
      this._cycleCompletedForEmotion = emotion;
      try {
        this._cycleCompleteHandler(emotion);
      } catch (e) {
        console.warn("[SpriteRenderer] cycle handler failed:", e);
      }
    }

    _playTransition(frames, onDone) {
      this._transitionQueue = [...frames];
      let idx = 0;
      const step = () => {
        if (idx >= this._transitionQueue.length) {
          this._transitionQueue = [];
          onDone && onDone();
          return;
        }
        this._applyFrame(this._transitionQueue[idx++]);
        setTimeout(step, 50);  // 50 ms transition frame interval
      };
      step();
    }
  }

  // ---------------------------------------------------------------------------
  // RenderApp — top-level orchestrator for the Electron scene host
  // ---------------------------------------------------------------------------
  class RenderApp {
    constructor() {
      if (typeof window.__SALIERI_CHARACTER_FACTORY__ !== "function") {
        throw new Error("[RenderApp] character factory unavailable; /next/scene.js must load before renderer.js");
      }
      this._sprite = new SpriteRenderer(app.stage);
      this._character = window.__SALIERI_CHARACTER_FACTORY__(this._sprite);
      this._sprite.setCycleCompleteHandler((label) => this._character.onCycleComplete(label));

      // The sprite layer is the only foreground layer; the work surface lives
      // in the React shell, not here.
      app.stage.removeChildren();
      app.stage.addChild(this._sprite.container);

      // PixiJS' own resize event, fired after resizeTo applies, is more
      // reliable than window.resize. The callback w/h are physical pixels, so
      // use app.screen for logical pixels.
      app.renderer.on('resize', () => this._onResize());

      // Force one recalculation after the first ticker frame, when the canvas
      // already has the correct size.
      app.ticker.addOnce(() => this._onResize());
    }

    // ---- Public API (reached from wallpaper_scene.js through callRender) ----

    getPixiApp() {
      return app;
    }

    setSpriteViewportBounds(bounds) {
      this._sprite.setViewportBounds(bounds);
    }

    setSpriteViewportMask(mask) {
      this._sprite.container.mask = mask || null;
    }

    // ---- Internals ----

    _onResize() {
      this._sprite.resize(app.screen.width, app.screen.height);
      this._sprite._showFrame(this._sprite._frameIdx);
    }
  }

  window.renderApp = new RenderApp();
  console.log("[RenderEngine] renderer.js initialized");
})();
