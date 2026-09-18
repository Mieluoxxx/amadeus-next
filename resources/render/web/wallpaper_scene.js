/**
 * Desktop wallpaper adapter.
 *
 * Ownership boundary:
 * - character runtime delegates to render/web/renderer.js
 * - desktop scene owns wallpaper background, CRT mask, and occasional scanline noise
 * - wallpaperApp keeps the Python-facing flat API for compatibility
 */
(function () {
  "use strict";

  function callRender(method, args) {
    if (!window.renderApp || typeof window.renderApp[method] !== "function") {
      console.warn("[WallpaperScene] renderApp method unavailable:", method);
      return undefined;
    }
    return window.renderApp[method].apply(window.renderApp, args || []);
  }

  function diag(event, data, level) {
    const payload = data || {};
    const logLevel = level || "info";
    try {
      const fn = logLevel === "error" ? console.error : (logLevel === "warning" ? console.warn : console.info);
      fn.call(console, "[WallpaperDiag]", event, payload);
    } catch (err) {}
    try {
      if (typeof window.__weBridgeLog === "function") {
        window.__weBridgeLog(event, payload, logLevel);
      }
    } catch (err) {}
  }

  function urlFlagEnabled(name) {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const value = String(params.get(name) || "").toLowerCase();
      return value === "1" || value === "true" || value === "yes" || value === "on";
    } catch (err) {
      return false;
    }
  }

  function urlFlagDisabled(name) {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const value = String(params.get(name) || "").toLowerCase();
      return value === "0" || value === "false" || value === "no" || value === "off";
    } catch (err) {
      return false;
    }
  }

  const wallpaperSubtitle = {
    app: null,
    container: null,
    frame: null,
    text: null,
    frameUrl: "",
    currentText: "",
    enabled: true,
    _aspect: 2564 / 430,
    _bounds: null,

    init(app, payload) {
      this.app = app;
      const params = new URLSearchParams(window.location.search || "");
      this.enabled = !urlFlagDisabled("wallpaperSubtitle") && !urlFlagEnabled("noWallpaperSubtitle");
      this.frameUrl = String((payload && payload.subtitleFrameUrl) || params.get("subtitleFrame") || "");
      if (!this.container && this.app && window.PIXI) {
        this.container = new PIXI.Container();
        this.container.visible = false;
        this.frame = new PIXI.Sprite();
        this.text = new PIXI.Text("", {
          fontFamily: "Arial, 'Microsoft YaHei', sans-serif",
          fontSize: 15,
          fill: 0xf2f7fb,
          align: "center",
          wordWrap: true,
          wordWrapWidth: 360,
          breakWords: true,
          lineHeight: 20,
          dropShadow: true,
          dropShadowColor: 0x071019,
          dropShadowAlpha: 0.85,
          dropShadowDistance: 1,
          dropShadowBlur: 2,
        });
        this.text.anchor.set(0.5, 0.5);
        this.container.addChild(this.frame);
        this.container.addChild(this.text);
        this.app.stage.addChild(this.container);
      }
      this._loadFrame();
      this.updateVisibility();
    },

    _loadFrame() {
      if (!this.frame || !this.frameUrl || !window.PIXI) return;
      const tex = PIXI.Texture.from(this.frameUrl);
      const apply = () => {
        if (!this.frame || !tex || !tex.baseTexture || !tex.baseTexture.valid) return;
        this.frame.texture = tex;
        this._aspect = Math.max(1, (tex.width || 2564) / Math.max(1, tex.height || 430));
        this.layout(this._bounds);
        diag("subtitle.frame_ready", { url: this.frameUrl, width: tex.width || 0, height: tex.height || 0 });
      };
      if (tex.baseTexture && tex.baseTexture.valid) {
        apply();
      } else if (tex.baseTexture) {
        tex.baseTexture.once("loaded", apply);
        tex.baseTexture.once("error", (err) => diag("subtitle.frame_error", { error: String(err) }, "warning"));
      }
    },

    setText(value) {
      this.currentText = String(value || "").trim();
      if (this.text) this.text.text = this.currentText;
      this.layout(this._bounds);
      this.updateVisibility();
    },

    layout(bounds) {
      this._bounds = bounds || this._bounds;
      if (!this.container || !this.frame || !this.text || !this._bounds) return;
      const b = this._bounds;
      const width = Math.max(180, Math.min(b.width * 0.72, b.width - 24));
      const height = Math.max(34, Math.min(width / this._aspect, b.height * 0.16));
      const x = b.x + (b.width - width) / 2;
      const y = b.y + b.height - height - Math.max(3, b.height * 0.012);
      this.frame.x = x;
      this.frame.y = y;
      if (this.frame.texture && this.frame.texture.valid) {
        this.frame.width = width;
        this.frame.height = height;
      }
      const fontSize = Math.max(11, Math.min(17, Math.round(width / 34)));
      this.text.style.fontSize = fontSize;
      this.text.style.lineHeight = Math.round(fontSize * 1.32);
      this.text.style.wordWrapWidth = width * 0.82;
      this.text.x = x + width / 2;
      this.text.y = y + height * 0.52;
    },

    updateVisibility() {
      if (!this.container) return;
      const visible = !!(this.enabled && this.currentText);
      this.container.visible = visible;
      if (visible && this.app && this.app.stage && this.app.stage.children.includes(this.container)) {
        this.app.stage.addChild(this.container);
      }
    },
  };

  const desktopScene = {
    app: null,
    cfg: {},
    bg: null,
    mask: null,
    staticOverlay: null,
    ambientLayer: null,
    glowLayer: null,
    scanlineLayer: null,
    ambientLowSprite: null,
    ambientSprite: null,
    backgroundUrl: "",
    ambientUrl: "",
    ambientLowUrl: "",
    _resizeBound: null,
    _tickerBound: null,
    _points: null,
    _crtBounds: null,
    _time: 0,
    _speakingGate: 0,
    _mouthPulse: 0,
    _ambientNoise: 0,
    _ambientNoiseTarget: 0,
    _ambientNoiseTimer: 0,
    _ambientBurst: 0,
    _ambientBurstAge: 0,
    _ambientBurstDuration: 0,
    _ambientBurstDelay: 2.2,
    _scanlineFlash: 0,
    _lastSubtitleText: "",
    _subtitleClearTimer: null,
    _subtitleClearDelayMs: 15000,

    init(payload) {
      this.app = callRender("getPixiApp", []);
      if (!this.app || !window.PIXI) {
        console.error("[WallpaperScene] Pixi app unavailable; desktop scene not initialized");
        return;
      }

      if (!this.mask) {
        this.mask = new PIXI.Graphics();
        this.mask.renderable = false;
        this.staticOverlay = new PIXI.Graphics();
        this.ambientLayer = new PIXI.Container();
        this.glowLayer = new PIXI.Graphics();
        this.scanlineLayer = new PIXI.Graphics();
        if (PIXI.BLEND_MODES && PIXI.BLEND_MODES.ADD) {
          this.glowLayer.blendMode = PIXI.BLEND_MODES.ADD;
        }
        this.app.stage.addChild(this.mask);
        this.app.stage.addChild(this.staticOverlay);
        this.app.stage.addChild(this.ambientLayer);
        this.app.stage.addChild(this.glowLayer);
        this.app.stage.addChild(this.scanlineLayer);
        this.scanlineLayer.mask = this.mask;
        callRender("setSpriteViewportMask", [this.mask]);
        this._resizeBound = () => this.layout();
        this._tickerBound = (delta) => this.tick(delta);
        window.addEventListener("resize", this._resizeBound);
        this.app.ticker.add(this._tickerBound);
      }

      this.cfg = (payload && payload.crtConfig) || {};
      this._ambientBurstDelay = this._ambientBurstInterval();
      this.setAmbientLow((payload && payload.ambientLowUrl) || "");
      this.setAmbientHigh((payload && payload.ambientUrl) || "");
      this.setBackground((payload && payload.backgroundUrl) || "");
      wallpaperSubtitle.init(this.app, payload || {});
      this.layout();
      console.log("[WallpaperScene] initialized with separated scene/character controllers");
      diag("desktop.init", {
        hasBackground: !!(payload && payload.backgroundUrl),
        hasAmbientLow: !!(payload && payload.ambientLowUrl),
        hasAmbientHigh: !!(payload && payload.ambientUrl),
        stageChildren: this.app && this.app.stage ? this.app.stage.children.length : 0,
      });
    },

    setBackground(url) {
      if (!this.app) return;
      if (!url) {
        console.warn("[WallpaperScene] empty background url; keeping previous background");
        diag("background.empty_url_keep_existing", { hadBackground: !!this.bg }, "warning");
        return;
      }
      if (this.bg && this.backgroundUrl === url) {
        diag("background.same_url_keep_existing", { url });
        return;
      }

      const previousBg = this.bg;
      const previousUrl = this.backgroundUrl;
      const tex = PIXI.Texture.from(url);
      diag("background.load_start", { url, previousUrl: previousUrl || "" });
      const installBackground = () => {
        const nextBg = new PIXI.Sprite(tex);
        this.app.stage.addChildAt(nextBg, 0);
        this.bg = nextBg;
        this.backgroundUrl = url;
        this.layout();
        if (previousBg && previousBg !== nextBg) {
          try {
            this.app.stage.removeChild(previousBg);
            previousBg.destroy({ texture: true, baseTexture: true });
          } catch (err) {
            console.warn("[WallpaperScene] previous background cleanup failed:", err);
          }
        }
        diag("background.ready", {
          url,
          width: tex.baseTexture ? tex.baseTexture.width : 0,
          height: tex.baseTexture ? tex.baseTexture.height : 0,
          stageChildren: this.app && this.app.stage ? this.app.stage.children.length : 0,
        });
      };
      const failBackground = (err) => {
        console.warn("[WallpaperScene] background load failed; keeping previous background:", url, err);
        diag("background.error_keep_existing", {
          url,
          previousUrl: previousUrl || "",
          error: String(err && (err.message || err)),
        }, "error");
      };
      if (!tex.baseTexture.valid) {
        tex.baseTexture.once("loaded", installBackground);
        tex.baseTexture.once("error", failBackground);
      } else {
        installBackground();
      }
    },

    setAmbientHigh(url) {
      this.ambientUrl = url || "";
      if (!this.ambientUrl) return;
      this._loadAmbientSprite(this.ambientUrl);
    },

    setAmbientLow(url) {
      this.ambientLowUrl = url || "";
      if (!this.ambientLowUrl) return;
      this._loadAmbientLowSprite(this.ambientLowUrl);
    },

    _replaceAmbientLowSprite(texture) {
      if (this.ambientLowSprite) {
        this.ambientLayer.removeChild(this.ambientLowSprite);
        this.ambientLowSprite.destroy({ texture: true, baseTexture: true });
      }
      this.ambientLowSprite = new PIXI.Sprite(texture);
      this.ambientLowSprite.width = this.app.screen.width;
      this.ambientLowSprite.height = this.app.screen.height;
      this.ambientLowSprite.alpha = this._ambientLowIdleAlpha();
      this.ambientLayer.addChildAt(this.ambientLowSprite, 0);
      console.info("[WallpaperScene] ambient low layer ready:", {
        alpha: this.ambientLowSprite.alpha,
      });
      this._drawGlow();
    },

    _loadAmbientLowSprite(url) {
      if (!this.app || !url) return;
      const texture = PIXI.Texture.from(url);
      const applyTexture = () => this._replaceAmbientLowSprite(texture);
      if (texture.baseTexture.valid) {
        applyTexture();
      } else {
        texture.baseTexture.once("loaded", applyTexture);
        texture.baseTexture.once("error", (err) => {
          console.warn("[WallpaperScene] ambient low image failed:", url, err);
        });
      }
    },

    _replaceAmbientSprite(texture) {
      if (this.ambientSprite) {
        this.ambientLayer.removeChild(this.ambientSprite);
        this.ambientSprite.destroy({ texture: true, baseTexture: true });
      }
      this.ambientSprite = new PIXI.Sprite(texture);
      this.ambientSprite.width = this.app.screen.width;
      this.ambientSprite.height = this.app.screen.height;
      this.ambientSprite.alpha = this._ambientBaseAlpha();
      if (PIXI.BLEND_MODES && PIXI.BLEND_MODES.ADD) {
        this.ambientSprite.blendMode = PIXI.BLEND_MODES.ADD;
      }
      this.ambientLayer.addChild(this.ambientSprite);
      console.info("[WallpaperScene] ambient layer ready:", {
        alpha: this.ambientSprite.alpha,
      });
      this._drawGlow();
    },

    _loadAmbientSprite(url) {
      if (!this.app || !url) return;
      const texture = PIXI.Texture.from(url);
      const applyTexture = () => this._replaceAmbientSprite(texture);
      if (texture.baseTexture.valid) {
        applyTexture();
      } else {
        texture.baseTexture.once("loaded", applyTexture);
        texture.baseTexture.once("error", (err) => {
          console.warn("[WallpaperScene] ambient image failed:", url, err);
        });
      }
    },

    _cfgNumber(key, fallback) {
      const value = Number(this.cfg[key]);
      return Number.isFinite(value) ? value : fallback;
    },

    _ambientBaseAlpha() {
      return Math.max(0, Math.min(1.5, this._cfgNumber("ambient_alpha_idle", 0.0)));
    },

    _ambientPulseAlpha() {
      return Math.max(0, Math.min(1.5, this._cfgNumber("ambient_alpha_pulse", 0.95)));
    },

    _ambientLowIdleAlpha() {
      return Math.max(0, Math.min(1.5, this._cfgNumber("ambient_low_alpha_idle", 0.78)));
    },

    _ambientLowMinAlpha() {
      return Math.max(0, Math.min(1.5, this._cfgNumber("ambient_low_alpha_min", 0.12)));
    },

    _ambientBurstInterval() {
      const minSeconds = Math.max(0, this._cfgNumber("ambient_burst_interval_min", 12));
      const maxSeconds = Math.max(minSeconds, this._cfgNumber("ambient_burst_interval_max", 20));
      return minSeconds + Math.random() * (maxSeconds - minSeconds);
    },

    _ambientBurstEnabled() {
      if (urlFlagEnabled("noAmbientBurst") || urlFlagDisabled("ambientBurst")) return false;
      if (this.cfg && Object.prototype.hasOwnProperty.call(this.cfg, "ambient_burst_enabled")) {
        const value = this.cfg.ambient_burst_enabled;
        if (typeof value === "boolean") return value;
        const normalized = String(value).toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
      }
      return true;
    },

    _clearSubtitleTimer() {
      if (this._subtitleClearTimer) {
        window.clearTimeout(this._subtitleClearTimer);
        this._subtitleClearTimer = null;
      }
    },

    _scheduleSubtitleClear(expectedText) {
      this._clearSubtitleTimer();
      if (!expectedText) return;
      this._subtitleClearTimer = window.setTimeout(() => {
        this._subtitleClearTimer = null;
        if (this._lastSubtitleText !== expectedText) return;
        this._lastSubtitleText = "";
        wallpaperSubtitle.setText("");
        diag("subtitle.auto_cleared", { delayMs: this._subtitleClearDelayMs });
      }, this._subtitleClearDelayMs);
    },

    _crtPoints() {
      const app = this.app;
      const imgSize = this.cfg.img_size || [app.screen.width, app.screen.height];
      const rawPoints = this.cfg.crt_polygon || this.cfg.crt_corners || [
        [0, 0],
        [app.screen.width, 0],
        [app.screen.width, app.screen.height],
        [0, app.screen.height],
      ];
      const sx = app.screen.width / Math.max(1, Number(imgSize[0]) || 1);
      const sy = app.screen.height / Math.max(1, Number(imgSize[1]) || 1);
      return rawPoints.map((p) => ({ x: Number(p[0]) * sx, y: Number(p[1]) * sy }));
    },

    _computeBounds(points) {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      return { x, y, width: right - x, height: bottom - y, right, bottom };
    },

    layout() {
      if (!this.app || !this.mask || !this.staticOverlay) return;
      if (this.bg) {
        this.bg.x = 0;
        this.bg.y = 0;
        this.bg.width = this.app.screen.width;
        this.bg.height = this.app.screen.height;
      }
      if (this.ambientLowSprite) {
        this.ambientLowSprite.width = this.app.screen.width;
        this.ambientLowSprite.height = this.app.screen.height;
      }
      if (this.ambientSprite) {
        this.ambientSprite.width = this.app.screen.width;
        this.ambientSprite.height = this.app.screen.height;
      }

      const points = this._crtPoints();
      const bounds = this._computeBounds(points);
      this._points = points;
      this._crtBounds = bounds;

      this.mask.clear();
      this.mask.beginFill(0xffffff, 1);
      this.mask.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) this.mask.lineTo(points[i].x, points[i].y);
      this.mask.lineTo(points[0].x, points[0].y);
      this.mask.endFill();

      this.staticOverlay.clear();
      this._drawPolygon(this.staticOverlay, points, 0x07121c, 0.10);

      callRender("setSpriteViewportBounds", [bounds]);
      wallpaperSubtitle.layout(bounds);
      this._drawGlow();
      this._drawScanlineNoise();
    },

    setSpeaking(speaking) {
      this._speakingGate = speaking ? 1 : 0;
      wallpaperSubtitle.updateVisibility();
    },

    setMouth(value) {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      if (v > this._mouthPulse) this._mouthPulse = v;
    },

    tick(delta) {
      if (!this.app || !this._crtBounds || !this._points) return;
      const dt = Math.min(0.05, Math.max(0, (this.app.ticker.deltaMS || (delta * 16.6667)) / 1000));
      this._time += dt;
      const decay = this._speakingGate > 0 ? 2.8 : 5.5;
      this._mouthPulse = Math.max(0, this._mouthPulse - dt * decay);
      this._ambientNoiseTimer -= dt;
      if (this._ambientNoiseTimer <= 0) {
        this._ambientNoiseTimer = 0.28 + Math.random() * 0.42;
        this._ambientNoiseTarget = (Math.random() - 0.5) * 0.018;
      }
      this._ambientNoise += (this._ambientNoiseTarget - this._ambientNoise) * Math.min(1, dt * 4.2);
      if (this._ambientBurstEnabled() && this._ambientBurstDuration > 0) {
        this._ambientBurstAge += dt;
        const t = Math.min(1, this._ambientBurstAge / this._ambientBurstDuration);
        this._ambientBurst = Math.sin(Math.PI * t);
        if (t >= 1) {
          this._ambientBurst = 0;
          this._ambientBurstDuration = 0;
          this._ambientBurstDelay = this._ambientBurstInterval();
        }
      } else if (this._ambientBurstEnabled()) {
        this._ambientBurstDelay -= dt;
        if (this._ambientBurstDelay <= 0) {
          this._ambientBurstAge = 0;
          this._ambientBurstDuration = 0.75 + Math.random() * 0.60;
        }
      } else {
        this._ambientBurst = 0;
        this._ambientBurstDuration = 0;
        this._ambientBurstAge = 0;
      }
      this._scanlineFlash = Math.max(0, this._scanlineFlash - dt * 3.8);
      if (Math.random() < dt * 0.075) {
        this._scanlineFlash = 0.75 + Math.random() * 0.25;
      }
      wallpaperSubtitle.updateVisibility();
      this._drawGlow();
      this._drawScanlineNoise();
    },

    _drawGlow() {
      if (!this.glowLayer || !this._crtBounds || !this._points) return;
      const pulse = Math.max(0, Math.min(1, this._mouthPulse));
      this.glowLayer.clear();
      this._drawAmbientLamp(pulse);
      if (pulse <= 0.01) return;

      const screenAlpha = pulse * 0.018;
      const roomAlpha = pulse * 0.006;
      this.glowLayer.beginFill(0x73d8ff, roomAlpha);
      this.glowLayer.drawRect(0, 0, this.app.screen.width, this.app.screen.height);
      this.glowLayer.endFill();
      this._drawPolygon(this.glowLayer, this._points, 0x9be9ff, screenAlpha);
    },

    _scaledRect(rect) {
      if (!rect || rect.length < 4 || !this.app) return null;
      const imgSize = this.cfg.img_size || [this.app.screen.width, this.app.screen.height];
      const sx = this.app.screen.width / Math.max(1, Number(imgSize[0]) || 1);
      const sy = this.app.screen.height / Math.max(1, Number(imgSize[1]) || 1);
      return {
        x: Number(rect[0]) * sx,
        y: Number(rect[1]) * sy,
        width: Number(rect[2]) * sx,
        height: Number(rect[3]) * sy,
      };
    },

    _scaledPoint(point, fallback) {
      const imgSize = this.cfg.img_size || [this.app.screen.width, this.app.screen.height];
      const sx = this.app.screen.width / Math.max(1, Number(imgSize[0]) || 1);
      const sy = this.app.screen.height / Math.max(1, Number(imgSize[1]) || 1);
      const p = point && point.length >= 2 ? point : fallback;
      return {
        x: Number(p[0]) * sx,
        y: Number(p[1]) * sy,
      };
    },

    _drawAmbientLamp(pulse) {
      if (!this.ambientSprite && !this.ambientLowSprite) return;
      const idleDrift = 0.004 * (0.5 + 0.5 * Math.cos(this._time * 0.38 + 0.7));
      const burst = this._ambientBurst * (0.82 + Math.max(0, this._ambientNoise) * 2.8);
      const speech = this._speakingGate ? 0.16 : 0;
      const mouth = Math.max(0, Math.min(1, pulse)) * 0.22;
      const intensity = Math.max(0, Math.min(1.2, burst + speech + mouth + idleDrift + this._ambientNoise));
      if (this.ambientLowSprite) {
        const lowIdle = this._ambientLowIdleAlpha();
        const lowMin = this._ambientLowMinAlpha();
        this.ambientLowSprite.alpha = Math.max(0, Math.min(1.25, lowMin + (1 - Math.min(1, intensity)) * (lowIdle - lowMin)));
      }
      if (this.ambientSprite) {
        const alpha = this._ambientBaseAlpha() + intensity * this._ambientPulseAlpha();
        this.ambientSprite.alpha = Math.max(0, Math.min(1.25, alpha));
      }
    },

    _drawScanlineNoise() {
      if (!this.scanlineLayer || !this._crtBounds) return;
      const bounds = this._crtBounds;
      this.scanlineLayer.clear();
      const scanAlpha = Math.max(0, Math.min(0.30, ((this.cfg.scanline_alpha || 32) / 255)));
      const scanOffset = (this._time * 14) % 3;
      this.scanlineLayer.lineStyle(1, 0x000000, scanAlpha * 0.82);
      for (let y = bounds.y + scanOffset; y < bounds.bottom; y += 3) {
        this.scanlineLayer.moveTo(bounds.x, y);
        this.scanlineLayer.lineTo(bounds.right, y);
      }

      if (this._scanlineFlash > 0) {
        const n = 1 + Math.floor(this._scanlineFlash * 4);
        for (let i = 0; i < n; i += 1) {
          const y = bounds.y + Math.random() * bounds.height;
          const x = bounds.x + Math.random() * bounds.width * 0.25;
          const w = bounds.width * (0.25 + Math.random() * 0.75);
          const a = 0.025 + this._scanlineFlash * (0.035 + Math.random() * 0.045);
          this.scanlineLayer.lineStyle(1 + Math.random() * 1.5, 0xc9f7ff, a);
          this.scanlineLayer.moveTo(x, y);
          this.scanlineLayer.lineTo(Math.min(bounds.right, x + w), y + (Math.random() - 0.5) * 2);
        }
      }
    },

    _drawPolygon(graphics, points, color, alpha) {
      if (!points || points.length < 3 || alpha <= 0) return;
      graphics.beginFill(color, alpha);
      graphics.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) graphics.lineTo(points[i].x, points[i].y);
      graphics.lineTo(points[0].x, points[0].y);
      graphics.endFill();
    },

    _strokePolygon(graphics, points) {
      if (!points || points.length < 3) return;
      graphics.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) graphics.lineTo(points[i].x, points[i].y);
      graphics.lineTo(points[0].x, points[0].y);
    },
  };

  try {
    app.view.addEventListener("webglcontextlost", function (event) {
      console.error("[WallpaperScene] WebGL context lost; preventing default restore path", event);
      diag("webgl.context_lost", {}, "error");
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    }, false);
    app.view.addEventListener("webglcontextrestored", function () {
      console.info("[WallpaperScene] WebGL context restored");
      diag("webgl.context_restored");
      if (window.wallpaperApp && window.wallpaperApp.scene) {
        window.wallpaperApp.scene.layout();
      }
    }, false);
  } catch (err) {
    console.warn("[WallpaperScene] WebGL context monitor unavailable:", err);
  }

  window.wallpaperApp = {
    scene: desktopScene,

    initDesktopScene(payload) { desktopScene.init(payload || {}); },

    setSubtitle(text) {
      const value = String(text || "");
      desktopScene._lastSubtitleText = value;
      wallpaperSubtitle.setText(value);
      desktopScene._scheduleSubtitleClear(value);
    },
  };

  console.log("[WallpaperScene] ready");
})();
