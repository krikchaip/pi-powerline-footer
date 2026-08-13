import test from "node:test";
import assert from "node:assert/strict";
import { installPowerlineFooterLifecyclePatch } from "../index.ts";

const POWERLINE_FOOTER_FACTORY = Symbol.for("pi-powerline-footer.footer-factory");

function powerlineFooterFactory(component: unknown) {
  const factory = () => component;
  Object.defineProperty(factory, POWERLINE_FOOTER_FACTORY, { value: true });
  return factory;
}

type FooterMode = {
  customFooter?: unknown;
  footer: object;
  footerContainer: {
    children: unknown[];
    clear(): void;
    addChild(component: unknown): void;
  };
  editor?: unknown;
  editorContainer?: {
    children: unknown[];
    clear(): void;
    addChild(component: unknown): void;
  };
  extensionWidgetsAbove?: Map<string, unknown>;
  extensionWidgetsBelow?: Map<string, unknown>;
  renderer?: {
    renderRequested: boolean;
    requestRender(force?: boolean): void;
    requestImmediateRender(): void;
    renderNow(force?: boolean): void;
    cancelRenderTimer(): void;
  };
};

function createFooterContainer(nativeFooter: object) {
  return {
    children: [nativeFooter] as unknown[],
    clear() {
      this.children = [];
    },
    addChild(component: unknown) {
      this.children.push(component);
    },
  };
}

function createPrototype(
  bindFooter: (mode: FooterMode) => void = () => {},
) {
  return {
    mountInteractiveTui(this: FooterMode) {
      this.renderer?.requestRender();
    },
    resetExtensionUI(this: FooterMode) {
      this.customFooter = undefined;
      this.footerContainer.clear();
      this.footerContainer.addChild(this.footer);
    },
    setExtensionFooter(this: FooterMode, factory: (() => unknown) | undefined) {
      this.customFooter = factory?.();
      this.footerContainer.children = this.customFooter ? [this.customFooter] : [this.footer];
      this.renderer?.requestRender();
    },
    async rebindCurrentSession(this: FooterMode) {
      bindFooter(this);
    },
    async handleReloadCommand() {},
  };
}

function createMode(renderFrames: unknown[][] = []): FooterMode {
  const footer = { name: "native footer" };
  const mode: FooterMode = {
    footer,
    footerContainer: createFooterContainer(footer),
  };
  const capture = () => {
    renderFrames.push([...mode.footerContainer.children]);
  };
  mode.renderer = {
    renderRequested: false,
    requestRender: capture,
    requestImmediateRender: capture,
    renderNow: capture,
    cancelRenderTimer() {},
  };
  return mode;
}

function createDockMode() {
  const mode = createMode();
  const powerlineEditor = { name: "Powerline editor" };
  const powerlineFooter = { name: "Powerline footer" };
  const powerlineWidget = { name: "Powerline widget" };
  mode.customFooter = powerlineFooter;
  mode.footerContainer.children = [powerlineFooter];
  mode.editor = powerlineEditor;
  mode.editorContainer = createFooterContainer(powerlineEditor);
  mode.extensionWidgetsAbove = new Map([["powerline-session-title", powerlineWidget]]);
  mode.extensionWidgetsBelow = new Map();
  return { mode, powerlineEditor, powerlineFooter, powerlineWidget };
}

test("startup does not render Pi's native editor or footer before Powerline binds", () => {
  const renderFrames: unknown[][] = [];
  const powerlineFooter = { name: "Powerline footer" };
  const prototype = createPrototype();
  const mode = createMode(renderFrames);

  installPowerlineFooterLifecyclePatch(prototype);
  prototype.mountInteractiveTui.call(mode);
  assert.deepEqual(renderFrames, []);

  prototype.setExtensionFooter.call(mode, powerlineFooterFactory(powerlineFooter));

  assert.deepEqual(renderFrames, [[powerlineFooter]]);
});

test("the last complete Powerline dock frame stays visible during session replacement", async () => {
  const renderFrames: unknown[][] = [];
  const { mode, powerlineEditor, powerlineFooter, powerlineWidget } = createDockMode();
  const captureDock = () => {
    renderFrames.push([
      mode.editor,
      ...mode.footerContainer.children,
      ...mode.extensionWidgetsAbove!.values(),
    ]);
  };
  mode.renderer = {
    renderRequested: false,
    requestRender: captureDock,
    requestImmediateRender: captureDock,
    renderNow: captureDock,
    cancelRenderTimer() {},
  };
  const nextPowerlineEditor = { name: "next Powerline editor" };
  const nextPowerlineFooter = { name: "next Powerline footer" };
  const prototype = {
    mountInteractiveTui() {},
    resetExtensionUI(this: FooterMode) {
      this.customFooter = undefined;
      this.footerContainer.children = [this.footer];
      this.editor = { name: "native editor" };
      this.editorContainer!.children = [this.editor];
      this.extensionWidgetsAbove!.clear();
      this.renderer?.requestRender();
    },
    async rebindCurrentSession(this: FooterMode) {
      this.customFooter = nextPowerlineFooter;
      this.footerContainer.children = [nextPowerlineFooter];
      this.editor = nextPowerlineEditor;
      this.renderer?.requestRender();
    },
    async handleReloadCommand() {},
  };

  captureDock();
  installPowerlineFooterLifecyclePatch(prototype);
  prototype.resetExtensionUI.call(mode);
  assert.deepEqual(renderFrames, [[powerlineEditor, powerlineFooter, powerlineWidget]]);

  await prototype.rebindCurrentSession.call(mode);
  assert.deepEqual(renderFrames, [
    [powerlineEditor, powerlineFooter, powerlineWidget],
    [nextPowerlineEditor, nextPowerlineFooter],
  ]);
});

test("native footer returns when Powerline does not bind", async () => {
  const renderFrames: unknown[][] = [];
  const prototype = createPrototype();
  const mode = createMode(renderFrames);

  installPowerlineFooterLifecyclePatch(prototype);
  prototype.resetExtensionUI.call(mode);
  await prototype.rebindCurrentSession.call(mode);

  assert.deepEqual(mode.footerContainer.children, [mode.footer]);
  assert.deepEqual(renderFrames, [[mode.footer]]);
});
