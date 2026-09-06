import Phaser from "phaser";
import { SimClient } from "../net/SimClient";
import { TouchJoystick } from "../input/TouchJoystick";
import { carTextureFor, pedestrianTextureFor, signalTextureFor } from "../render/textureSelection";
import { computeMapBounds, computeCameraFit, type CameraFit } from "../render/mapBounds";
import { sampleCenterline } from "../render/roadCenterline";

interface MapDefinitionLike {
  intersections: { id: string; x: number; y: number }[];
  approaches: {
    id: string;
    laneStartX: number;
    laneStartY: number;
    laneEndX: number;
    laneEndY: number;
    width: number;
    waypoints?: { x: number; y: number }[];
  }[];
  pedestrianNodes: { id: string; x: number; y: number }[];
  pedestrianEdges: { from: string; to: string; kind: "sidewalk" | "crosswalk" }[];
}

export class MainScene extends Phaser.Scene {
  private client!: SimClient;
  private carSprites = new Map<string, Phaser.GameObjects.Rectangle | Phaser.GameObjects.Sprite>();
  private carControllers = new Map<string, "idm" | "user" | "ev">();
  private pedestrianSprites = new Map<string, Phaser.GameObjects.Arc | Phaser.GameObjects.Sprite>();
  private pedestrianWalkTick = new Map<string, number>();
  private signalDots = new Map<string, Phaser.GameObjects.Arc | Phaser.GameObjects.Sprite>();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private touchJoystick!: TouchJoystick;
  private myCarId: string | null = null;
  private kpiText!: Phaser.GameObjects.Text;
  private cameraFit!: CameraFit;
  private logText!: Phaser.GameObjects.Text;
  private logLines: string[] = [];
  private lastSignalPhase = new Map<string, string>();
  private signalTooltip!: Phaser.GameObjects.Text;
  private hoveredIntersectionId: string | null = null;
  private latestSignals = new Map<string, { phase: string; msRemainingMin: number; light: "green" | "yellow" | "red" }>();

  constructor() {
    super("main");
  }

  preload() {
    this.load.atlas("game-atlas", "assets/atlas/game-atlas.png", "assets/atlas/game-atlas.json");
    // Same map the sim server loads (maps/city_v1.json) — served to the browser via a static
    // symlink at frontend/public/maps/city_v1.json so the background tile layout below is
    // derived from the map's own approach/intersection/pedestrian geometry rather than a second,
    // hand-copied set of pixel positions that could silently drift from the real map.
    this.load.json("map", "maps/city_v1.json");
  }

  // If the atlas failed to load (e.g. Task 1/2's asset-production steps haven't run yet in a
  // partial checkout), every creation site below falls back to the pre-existing placeholder
  // shape instead — nothing crashes, and every prior phase's manual smoke test keeps working.
  private get hasAtlas(): boolean {
    return this.textures.exists("game-atlas");
  }

  create() {
    // Camera auto-fits to the real map's bounding box (computed from its own geometry, not a
    // hardcoded ±350-unit assumption — that broke the moment a map bigger than grid_1x1_v1.json
    // existed) — everything below that should stay pinned to the screen rather than the world
    // must call setScrollFactor(0) (the same pattern TouchJoystick already uses for its own
    // screen-space controls), otherwise it renders at a world coordinate that ends up far outside
    // the visible viewport once the camera is centered/zoomed. World-space elements (signal dots,
    // background tiles) deliberately do NOT call setScrollFactor(0) — they're meant to move with
    // the map as the camera pans/zooms.
    const map = this.cache.json.get("map") as MapDefinitionLike | undefined;
    if (map) {
      const bounds = computeMapBounds(map);
      this.cameraFit = computeCameraFit(bounds, this.scale.width, this.scale.height);
      this.cameras.main.setZoom(this.cameraFit.zoom);
      this.cameras.main.centerOn(this.cameraFit.centerX, this.cameraFit.centerY);
      this.buildBackground(map);

      for (const intersection of map.intersections) {
        const dot = this.hasAtlas
          ? this.add.sprite(intersection.x, intersection.y - 30, "game-atlas", signalTextureFor("green")).setDisplaySize(14, 30)
          : this.add.circle(intersection.x, intersection.y - 30, 8, 0x00ff00);
        this.signalDots.set(intersection.id, dot);

        // Hover tooltip: a signal dot alone (a colored blob) tells a first-time viewer nothing
        // about what's actually driving it — hovering shows the same phase/countdown data the
        // live-analytics panel logs, right where the player is already looking. Hit area padded
        // out from the dot's own small size (8-14px) so it's actually easy to hover, not a
        // pixel-perfect target.
        dot.setInteractive(
          new Phaser.Geom.Rectangle(-15, -20, 30, 40),
          Phaser.Geom.Rectangle.Contains
        );
        dot.on("pointerover", () => {
          this.hoveredIntersectionId = intersection.id;
          this.updateSignalTooltip();
        });
        dot.on("pointerout", () => {
          if (this.hoveredIntersectionId === intersection.id) {
            this.hoveredIntersectionId = null;
            this.signalTooltip.setVisible(false);
          }
        });
      }

      this.signalTooltip = this.add
        .text(0, 0, "", {
          fontSize: "11px",
          color: "#ffffff",
          backgroundColor: "#000000e6",
          padding: { x: 8, y: 6 },
          lineSpacing: 2
        })
        .setDepth(1000)
        .setVisible(false);
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.touchJoystick = new TouchJoystick(this, 100, this.scale.height - 100, 60);

    // Manual scroll-to-zoom, clamped to the auto-fit range computed above; R restores the initial
    // full-map auto-fit exactly, so zooming in manually never strands the player without an easy
    // way back to the whole-city view (spec §11.4).
    const ZOOM_STEP = 0.1;
    this.input.on("wheel", (_pointer: unknown, _objects: unknown, _dx: number, dy: number) => {
      if (!this.cameraFit) return;
      const current = this.cameras.main.zoom;
      const next = dy > 0 ? current * (1 - ZOOM_STEP) : current * (1 + ZOOM_STEP);
      this.cameras.main.setZoom(Math.max(this.cameraFit.minZoom, Math.min(this.cameraFit.maxZoom, next)));
    });
    this.input.keyboard!.on("keydown-R", () => {
      if (!this.cameraFit) return;
      this.cameras.main.setZoom(this.cameraFit.zoom);
      this.cameras.main.centerOn(this.cameraFit.centerX, this.cameraFit.centerY);
    });

    // Click-and-hold-drag panning, like any real map viewer (Google Maps, etc.) — previously the
    // only way to look elsewhere on the map was scroll-to-zoom plus R, with no way to pan at a
    // fixed zoom level. `pointerOnUiElement` is set by "gameobjectdown", which Phaser always fires
    // *before* the generic "pointerdown" for the same press — so by the time "pointerdown" reads
    // it below, it already reflects whether this exact press landed on an interactive HUD element
    // (scenario buttons, AI-mode toggle, the touch joystick), and dragging never fights clicking
    // those. Reset only happens on release, not on the next press, so the ordering holds up.
    let isDraggingCamera = false;
    let pointerOnUiElement = false;
    this.input.on("gameobjectdown", () => {
      pointerOnUiElement = true;
    });
    this.input.on("pointerdown", () => {
      if (!pointerOnUiElement) isDraggingCamera = true;
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!isDraggingCamera || !pointer.isDown) return;
      const zoom = this.cameras.main.zoom;
      this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / zoom;
      this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / zoom;
    });
    this.input.on("pointerup", () => {
      isDraggingCamera = false;
      pointerOnUiElement = false;
    });

    this.client = new SimClient(`ws://${window.location.hostname}:8080`);
    this.client.onJoined((carId) => {
      this.myCarId = carId;
    });

    const modeLabel = this.add
      .text(this.scale.width - 160, 10, "Mode: rule_based", { fontSize: "14px", color: "#ffffff" })
      .setScrollFactor(0);
    let mode: "rule_based" | "rl" = "rule_based";
    const toggleButton = this.add
      .text(this.scale.width - 160, 30, "[toggle AI mode]", { fontSize: "14px", color: "#88ccff" })
      .setScrollFactor(0)
      .setInteractive();
    toggleButton.on("pointerdown", () => {
      mode = mode === "rule_based" ? "rl" : "rule_based";
      modeLabel.setText(`Mode: ${mode}`);
      this.client.sendControllerMode(mode);
    });

    this.input.keyboard!.on("keydown-E", () => {
      // Crosses 2 intersections (I3, I1) — a real, visible green wave for a player pressing E,
      // not just a single-intersection blip.
      this.client.sendDebugSpawnEv("far_i3", "far_i7a");
    });

    this.kpiText = this.add.text(10, 40, "", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);
    this.client.onKpiUpdate((kpi) => {
      this.kpiText.setText(
        `Avg wait: ${kpi.avgVehicleWaitS.toFixed(1)}s | Throughput: ${kpi.throughput} | ` +
          `Ped wait: ${kpi.avgPedWaitS.toFixed(1)}s | Jaywalks: ${kpi.jaywalkEvents} | Mode: ${kpi.currentMode}`
      );
      this.pushLog(
        `[KPI] wait=${kpi.avgVehicleWaitS.toFixed(2)}s thpt=${kpi.throughput} ` +
          `pedWait=${kpi.avgPedWaitS.toFixed(2)}s jaywalks=${kpi.jaywalkEvents} ctrl=${kpi.currentMode}`
      );
    });

    // Real-time analytics/log panel (right side, below the AI-mode toggle) — a running feed of
    // the actual server-computed numbers behind what's on screen (signal decisions, EV
    // green-wave preemption ETAs, periodic KPI snapshots), not a cosmetic readout. Every line
    // traces to a real value already on the wire (room_event / kpi_update / signals array) rather
    // than anything invented client-side — see pushLog, onRoomEvent below, and the signal-phase
    // diffing inside onState.
    const LOG_PANEL_WIDTH = 340;
    const logPanelBg = this.add
      .rectangle(this.scale.width - LOG_PANEL_WIDTH - 10, 56, LOG_PANEL_WIDTH, 260, 0x000000, 0.72)
      .setOrigin(0, 0)
      .setScrollFactor(0);
    const logPanelLabel = this.add
      .text(this.scale.width - LOG_PANEL_WIDTH - 4, 60, "LIVE ANALYTICS", { fontSize: "11px", color: "#88ccff" })
      .setScrollFactor(0);
    this.logText = this.add
      .text(this.scale.width - LOG_PANEL_WIDTH - 4, 76, "", {
        fontSize: "10px",
        color: "#7CFC7C",
        fontFamily: "monospace",
        wordWrap: { width: LOG_PANEL_WIDTH - 12 }
      })
      .setScrollFactor(0);
    this.client.onRoomEvent((event) => {
      switch (event.kind) {
        case "ev_spawn":
          this.pushLog(`[EV] ${event.evId} spawned, route ${event.route.join(" -> ")}`);
          break;
        case "ev_preempt":
          this.pushLog(`[EV] preempting ${event.intersectionId}, ETA=${event.etaS.toFixed(1)}s -> forcing green`);
          break;
        case "ev_complete":
          this.pushLog(`[EV] cleared network in ${event.transitTimeS.toFixed(1)}s`);
          break;
        case "collision":
          this.pushLog(`[!] collision: ${event.entities.join(" x ")} (${event.collisionKind})`);
          break;
        case "user_join":
          this.pushLog(`[join] client ${event.clientId.slice(0, 8)} -> car ${event.carId}`);
          break;
        case "user_leave":
          this.pushLog(`[leave] client ${event.clientId.slice(0, 8)}`);
          break;
      }
    });

    const scenarios: Array<{ id: "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure"; label: string }> = [
      { id: "rush_hour", label: "Rush Hour" },
      { id: "emergency_vehicle", label: "Emergency Vehicle" },
      { id: "chaos", label: "Chaos" },
      { id: "pedestrian_pressure", label: "Pedestrian Pressure" }
    ];
    scenarios.forEach((s, i) => {
      const button = this.add
        .text(10, 60 + i * 18, `[${s.label}]`, { fontSize: "12px", color: "#88ccff" })
        .setScrollFactor(0)
        .setInteractive();
      button.on("pointerdown", () => this.client.sendStartScenario(s.id));
    });

    this.client.onScenarioComplete((result) => this.showScenarioResult(result));

    // A real key table (color swatch next to each label, like a map legend) rather than a wall of
    // text — a first-time viewer can scan "swatch -> meaning" without reading every word, and it
    // states what each thing IS and DOES rather than assuming symbol-shorthand ("■"/"●") is
    // self-explanatory. Built as a Container so the whole table repositions as one unit on resize
    // instead of tracking every row's own coordinates.
    const LEGEND_WIDTH = 330;
    const legendRows: Phaser.GameObjects.GameObject[] = [];
    let legendY = 0;
    const addHeader = (text: string) => {
      legendRows.push(this.add.text(0, legendY, text, { fontSize: "12px", color: "#88ccff", fontStyle: "bold" }));
      legendY += 16;
    };
    const addLine = (text: string) => {
      legendRows.push(this.add.text(4, legendY, text, { fontSize: "11px", color: "#e0e0e0" }));
      legendY += 15;
    };
    const addSwatchRow = (draw: (x: number, y: number) => Phaser.GameObjects.GameObject, label: string) => {
      legendRows.push(draw(10, legendY + 6));
      legendRows.push(this.add.text(24, legendY, label, { fontSize: "11px", color: "#e0e0e0" }));
      legendY += 17;
    };

    addHeader("HOW TO PLAY");
    addLine("Arrow keys: Up = gas, Down = brake, Left/Right = steer");
    addLine("E: call an ambulance — watch signals ahead of it turn green");
    addLine("Click + drag: pan the view   |   Scroll: zoom   |   R: reset view");
    legendY += 6;
    addHeader("KEY");
    addSwatchRow((x, y) => this.add.rectangle(x, y, 14, 14, 0x33ff77), "Your car");
    addSwatchRow((x, y) => this.add.rectangle(x, y, 14, 14, 0x3388ff), "AI-driven traffic");
    addSwatchRow((x, y) => this.add.rectangle(x, y, 14, 14, 0xff2222), "Ambulance (emergency vehicle)");
    addSwatchRow((x, y) => this.add.circle(x, y, 6, 0xffcc00), "Pedestrian (person walking/crossing)");
    addSwatchRow((x, y) => this.add.circle(x, y, 6, 0x00ff00), "Signal GREEN — vehicles may go");
    addSwatchRow((x, y) => this.add.circle(x, y, 6, 0xffff00), "Signal YELLOW — clearing, slow down");
    addSwatchRow((x, y) => this.add.circle(x, y, 6, 0xff3333), "Signal RED — stop (hover any signal for details)");
    addSwatchRow((x, y) => this.add.rectangle(x, y, 16, 10, 0x2b2b2b), "Road — for vehicles");
    addSwatchRow((x, y) => this.add.rectangle(x, y, 16, 10, 0x8a8a8a), "Footpath — for pedestrians");

    const LEGEND_HEIGHT = legendY + 10;
    const legendBg = this.add.rectangle(0, 0, LEGEND_WIDTH, LEGEND_HEIGHT, 0x000000, 0.82).setOrigin(0, 0);
    const legendContainer = this.add.container(10, this.scale.height - LEGEND_HEIGHT - 4, [legendBg, ...legendRows]).setScrollFactor(0);

    this.client.onState((snapshot) => {
      const pedIds = new Set(snapshot.payload.pedestrians.map((p) => p.id));
      for (const p of snapshot.payload.pedestrians) {
        let sprite = this.pedestrianSprites.get(p.id);
        if (!sprite) {
          sprite = this.hasAtlas
            ? this.add.sprite(p.x, p.y, "game-atlas", pedestrianTextureFor(0))
            : this.add.circle(p.x, p.y, 5, 0xffcc00);
          this.pedestrianSprites.set(p.id, sprite);
          this.pedestrianWalkTick.set(p.id, 0);
        }
        sprite.setPosition(p.x, p.y);
        if (this.hasAtlas && "setTexture" in sprite) {
          const tick = (this.pedestrianWalkTick.get(p.id) ?? 0) + 1;
          this.pedestrianWalkTick.set(p.id, tick);
          if (tick % 15 === 0) {
            (sprite as Phaser.GameObjects.Sprite).setTexture("game-atlas", pedestrianTextureFor(Math.floor(tick / 15)));
          }
        }
      }
      this.removeStaleSprites(this.pedestrianSprites, pedIds);
      for (const id of this.pedestrianWalkTick.keys()) {
        if (!pedIds.has(id)) this.pedestrianWalkTick.delete(id);
      }

      const vehicleIds = new Set(snapshot.payload.vehicles.map((v) => v.id));
      for (const v of snapshot.payload.vehicles) {
        let sprite = this.carSprites.get(v.id);
        if (!sprite) {
          sprite = this.hasAtlas
            ? this.add.sprite(v.x, v.y, "game-atlas", carTextureFor(v.controller))
            : // 36x18: length (36, along travel direction) x width (18, perpendicular) — must match
              // VehicleBody's real Matter.js rectangle dimensions exactly, or rendered cars visibly
              // don't match their physical/collision footprint (they'd render sideways: narrow in the
              // direction of travel, wide perpendicular to it). Every "idm" car used to render
              // identically to the player's own "user" car (both plain blue) in this fallback path —
              // with a dozen indistinguishable blue cars on screen, the player couldn't tell which
              // one was theirs without the atlas loaded. Bright green picks the player's car out
              // clearly against the AI traffic's blue.
              this.add.rectangle(
                v.x,
                v.y,
                36,
                18,
                v.controller === "ev" ? 0xff2222 : v.controller === "user" ? 0x33ff77 : 0x3388ff
              );
          this.carSprites.set(v.id, sprite);
        } else if (v.controller !== this.carControllers.get(v.id)) {
          // A car's controller can change after its sprite was first created (e.g. a player
          // claiming a previously-AI-driven car) — re-sync the visual so it doesn't keep showing
          // the wrong color/texture for the rest of its life.
          if (this.hasAtlas && "setTexture" in sprite) {
            (sprite as Phaser.GameObjects.Sprite).setTexture("game-atlas", carTextureFor(v.controller));
          } else if ("setFillStyle" in sprite) {
            const color = v.controller === "ev" ? 0xff2222 : v.controller === "user" ? 0x33ff77 : 0x3388ff;
            (sprite as Phaser.GameObjects.Rectangle).setFillStyle(color);
          }
        }
        this.carControllers.set(v.id, v.controller);
        sprite.setPosition(v.x, v.y);
        sprite.setRotation(v.heading);
      }
      this.removeStaleSprites(this.carSprites, vehicleIds);
      for (const id of this.carControllers.keys()) {
        if (!vehicleIds.has(id)) this.carControllers.delete(id);
      }

      // One signal per intersection (Stage 2 generalized the server to emit the full array) —
      // `light` is always populated by the server's own SignalController now, so no phase-id
      // fallback heuristic is needed (the old one was specific to grid_1x1_v1.json's NS_through
      // naming and meaningless for city_v1.json's generic p1/p2 phase ids).
      for (const signal of snapshot.payload.signals) {
        const dot = this.signalDots.get(signal.intersectionId);
        if (!dot) continue;
        const light = signal.light ?? "red";
        if (this.hasAtlas && "setTexture" in dot) {
          (dot as Phaser.GameObjects.Sprite).setTexture("game-atlas", signalTextureFor(light));
        } else if ("setFillStyle" in dot) {
          const color = light === "green" ? 0x00ff00 : light === "yellow" ? 0xffff00 : 0xff3333;
          (dot as Phaser.GameObjects.Arc).setFillStyle(color);
        }

        // Logs a line only on an actual phase change (not every tick this signal happens to be
        // green) — msRemainingMin is the real countdown the signal's own decision loop computed,
        // straight off the wire, not derived/guessed client-side.
        const previousPhase = this.lastSignalPhase.get(signal.intersectionId);
        if (previousPhase !== undefined && previousPhase !== signal.phase) {
          this.pushLog(
            `[signal] ${signal.intersectionId}: ${previousPhase} -> ${signal.phase} (${light}, ` +
              `min ${(signal.msRemainingMin / 1000).toFixed(1)}s left)`
          );
        }
        this.lastSignalPhase.set(signal.intersectionId, signal.phase);

        this.latestSignals.set(signal.intersectionId, { phase: signal.phase, msRemainingMin: signal.msRemainingMin, light });
        if (this.hoveredIntersectionId === signal.intersectionId) this.updateSignalTooltip();
      }
    });

    // The canvas fills the whole browser window (Phaser.Scale.RESIZE, see main.ts) and tracks
    // live window resizes — re-fit the camera and reposition the screen-anchored HUD elements
    // (right-aligned mode toggle, bottom-anchored legend) whenever that happens, or they'd stay
    // pinned to the *old* window size's edges instead of the new one's.
    this.scale.on("resize", (gameSize: Phaser.Structs.Size) => {
      if (map) {
        const bounds = computeMapBounds(map);
        this.cameraFit = computeCameraFit(bounds, gameSize.width, gameSize.height);
        this.cameras.main.setZoom(this.cameraFit.zoom);
        this.cameras.main.centerOn(this.cameraFit.centerX, this.cameraFit.centerY);
      }
      modeLabel.setX(gameSize.width - 160);
      toggleButton.setX(gameSize.width - 160);
      legendContainer.setY(gameSize.height - LEGEND_HEIGHT - 4);
      logPanelBg.setX(gameSize.width - LOG_PANEL_WIDTH - 10);
      logPanelLabel.setX(gameSize.width - LOG_PANEL_WIDTH - 4);
      this.logText.setX(gameSize.width - LOG_PANEL_WIDTH - 4);
    });
  }

  // Appends one line to the live-analytics panel, keeping only the most recent MAX_LOG_LINES —
  // an unbounded log would eventually make Phaser re-layout an ever-growing text block every
  // frame, and nobody reads further back than a screen's worth anyway.
  private static readonly MAX_LOG_LINES = 16;
  private pushLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > MainScene.MAX_LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - MainScene.MAX_LOG_LINES);
    }
    this.logText.setText(this.logLines.join("\n"));
  }

  // Refreshes the hover tooltip's content and position from the latest known signal state for
  // whichever intersection is currently hovered — called both on pointerover and again on every
  // subsequent state update while still hovering, so the countdown visibly ticks down live rather
  // than freezing at whatever value it showed the instant the mouse arrived.
  private updateSignalTooltip(): void {
    if (!this.hoveredIntersectionId) {
      this.signalTooltip.setVisible(false);
      return;
    }
    const dot = this.signalDots.get(this.hoveredIntersectionId);
    const info = this.latestSignals.get(this.hoveredIntersectionId);
    if (!dot || !info) {
      this.signalTooltip.setVisible(false);
      return;
    }
    const lightWord = info.light === "green" ? "GREEN — go" : info.light === "yellow" ? "YELLOW — clearing" : "RED — stop";
    this.signalTooltip.setText(
      [
        `Intersection ${this.hoveredIntersectionId}`,
        `Signal: ${lightWord}`,
        `Active phase: ${info.phase}`,
        `Time left in this phase's minimum: ${(info.msRemainingMin / 1000).toFixed(1)}s`
      ].join("\n")
    );
    this.signalTooltip.setPosition(dot.x + 18, dot.y - 34);
    this.signalTooltip.setVisible(true);
  }

  update() {
    if (!this.myCarId) return;

    let throttle: number;
    let brake: number;
    let steer: number;
    let inputMethod: "keyboard" | "touch";

    if (this.touchJoystick.isActive()) {
      const out = this.touchJoystick.getOutput();
      throttle = out.throttle;
      brake = out.brake;
      steer = out.steer;
      inputMethod = "touch";
    } else {
      throttle = this.cursors.up.isDown ? 1 : 0;
      brake = this.cursors.down.isDown ? 1 : 0;
      steer = this.cursors.left.isDown ? -1 : this.cursors.right.isDown ? 1 : 0;
      inputMethod = "keyboard";
    }

    this.client.sendInput({ carId: this.myCarId, throttle, brake, steer, inputMethod });
  }

  private showScenarioResult(result: { scenario: string; result: "pass" | "fail"; avgWaitDeltaPct: number }): void {
    const color = result.result === "pass" ? "#33ff77" : "#ff5555";
    const text = this.add
      .text(this.scale.width / 2, this.scale.height / 2, `${result.scenario}: ${result.result.toUpperCase()}`, {
        fontSize: "28px",
        color,
        backgroundColor: "#000000aa",
        padding: { x: 16, y: 12 }
      })
      .setScrollFactor(0)
      .setOrigin(0.5);
    this.time.delayedCall(4000, () => text.destroy());
  }

  // Static background tiling, built once from the map's own approaches/intersections/
  // pedestrianNodes/pedestrianEdges rather than hardcoded pixel positions, so it can't silently
  // drift from grid_1x1_v1.json if that file ever changes. No-ops per tile if the atlas isn't
  // loaded (same graceful-fallback rule as every other sprite creation site in this scene) —
  // this only ever draws atlas sprites, never a placeholder shape, since a background of colored
  // rectangles wouldn't read as anything at the placeholder stage anyway.
  private buildBackground(map: MapDefinitionLike): void {
    if (!this.hasAtlas) return;

    // Every approach in grid_1x1_v1 shares one lane width (40); deriving cellSize from the map
    // data (rather than hardcoding 40) means a future map with a different width still tiles
    // correctly without a code change here.
    const cellSize = map.approaches[0]?.width ?? 40;
    const sidewalkCellSize = cellSize / 2;

    const placeTile = (x: number, y: number, texture: string, w: number, h: number, rotation: number): void => {
      this.add.sprite(x, y, "game-atlas", texture).setDisplaySize(w, h).setRotation(rotation);
    };

    for (const intersection of map.intersections) {
      placeTile(intersection.x, intersection.y, "road_intersection", cellSize, cellSize, 0);
    }

    // A road tile's square footprint is `cellSize` wide even when rotated to a steep angle.
    // Trimming by array *index* (skip only the first/last sample) guarantees clearance from the
    // intersection tile at that one approach's own end, and that's enough at a near-90-degree
    // junction where the next approach's nearest tile is far away regardless. At a sharp-angle
    // merge (a "Y" where two roads meet at a narrow angle — exactly the multi-branch intersections
    // in city_v1.json), though, two DIFFERENT approaches' nearest tiles can land close enough to
    // each other in absolute space that their rotated dashed-centerline textures stack into a
    // radiating "clock face" of crossing marks right at the vertex — a real, reproduced rendering
    // bug, not a signal-indicator issue (the signal dots are one per intersection, unaffected).
    // First-come-first-placed de-duplication across ALL approaches' candidate tiles (not just
    // within one approach) catches this: the threshold is well under `cellSize` so it never
    // touches two consecutive tiles on the *same* approach (which are always exactly `cellSize`
    // apart), only genuinely-overlapping tiles from two different converging approaches.
    const TILE_DEDUPE_DISTANCE = cellSize * 0.5;
    const placedRoadTiles: { x: number; y: number }[] = [];
    for (const approach of map.approaches) {
      // Samples the approach's real centerline — a straight line when it has no waypoints
      // (byte-identical tiling to the old direction-based loop for every existing map), or a
      // smooth curve through them otherwise. road_straight's dashed centerline renders vertically
      // by default (the old code's isVertical-N/S convention treated that as rotation 0); rotate
      // each tile to the sample's own local tangent + 90 degrees, generalizing the old fixed
      // 0-or-90-degree rotation to any angle. Trims the first/last sample so tiles don't overlap
      // the intersection tile at either endpoint.
      const samples = sampleCenterline(approach, cellSize);
      for (let i = 1; i < samples.length - 1; i++) {
        const sample = samples[i];
        const overlapsPlacedTile = placedRoadTiles.some(
          (p) => Math.hypot(sample.x - p.x, sample.y - p.y) < TILE_DEDUPE_DISTANCE
        );
        if (overlapsPlacedTile) continue;
        placedRoadTiles.push({ x: sample.x, y: sample.y });
        placeTile(sample.x, sample.y, "road_straight", cellSize, cellSize, sample.heading + Math.PI / 2);
      }
    }

    const nodeById = new Map(map.pedestrianNodes.map((n) => [n.id, n]));
    for (const edge of map.pedestrianEdges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;

      if (edge.kind === "sidewalk") {
        const dirX = dx / length;
        const dirY = dy / length;
        for (let d = sidewalkCellSize / 2; d < length; d += sidewalkCellSize) {
          placeTile(from.x + dirX * d, from.y + dirY * d, "sidewalk", sidewalkCellSize, sidewalkCellSize, 0);
        }
      } else {
        // crosswalk is drawn for a horizontal crossing (zebra bars elongated along local +x) by
        // default; rotate 90 degrees when the crossing itself runs closer to vertical (spans an
        // E/W road) instead — same convention road_straight uses for its own rotation.
        const isHorizontalCrossing = Math.abs(dx) >= Math.abs(dy);
        const rotation = isHorizontalCrossing ? 0 : Math.PI / 2;
        placeTile((from.x + to.x) / 2, (from.y + to.y) / 2, "crosswalk", length, sidewalkCellSize, rotation);
      }
    }
  }

  private removeStaleSprites(sprites: Map<string, Phaser.GameObjects.GameObject>, liveIds: Set<string>): void {
    for (const [id, sprite] of sprites) {
      if (!liveIds.has(id)) {
        sprite.destroy();
        sprites.delete(id);
      }
    }
  }
}
