import test from "node:test";
import assert from "node:assert/strict";
import { installPowerlineWelcomeHeaderPatch } from "../index.ts";

const WELCOME_HEADER_FACTORY = Symbol.for("pi-powerline-footer.welcome-header-factory");
const WELCOME_HEADER_REMOVED = Symbol.for("pi-powerline-footer.welcome-header-removed");

function markWelcomeFactory<T extends () => object>(factory: T, onRemoved?: () => void): T {
  Object.defineProperty(factory, WELCOME_HEADER_FACTORY, { value: true });
  if (onRemoved) Object.defineProperty(factory, WELCOME_HEADER_REMOVED, { value: onRemoved });
  return factory;
}

function createPrototype(originalHeaderCalls: unknown[]) {
  const loadedTheme = { name: "loaded theme" };
  const resourceGap = { name: "resource gap" };
  return {
    loadedTheme,
    resourceGap,
    prototype: {
      setExtensionHeader(factory: unknown) {
        originalHeaderCalls.push(factory);
      },
      showLoadedResources(this: { loadedResourcesContainer: { children: unknown[] } }) {
        this.loadedResourcesContainer.children = [loadedTheme, resourceGap];
      },
    },
  };
}

function createMode(nativeHeading: object, headerGap: object) {
  return {
    headerContainer: { children: [nativeHeading, headerGap] },
    loadedResourcesContainer: {
      children: [] as unknown[],
      addChild(component: unknown) {
        this.children.push(component);
      },
    },
    ui: { requestRender() {} },
  };
}

test("welcome patch renders the banner after Pi's loaded resources", () => {
  const originalHeaderCalls: unknown[] = [];
  const { prototype, loadedTheme, resourceGap } = createPrototype(originalHeaderCalls);
  const nativeHeading = { name: "native heading" };
  const headerGap = { name: "header gap" };
  let disposed = false;
  const banner = {
    dispose() {
      disposed = true;
    },
  };
  const mode = createMode(nativeHeading, headerGap);

  installPowerlineWelcomeHeaderPatch(prototype);
  prototype.setExtensionHeader.call(mode, markWelcomeFactory(() => banner));
  prototype.showLoadedResources.call(mode);

  assert.deepEqual(mode.headerContainer.children, [nativeHeading, headerGap]);
  assert.deepEqual(mode.loadedResourcesContainer.children, [loadedTheme, resourceGap, banner]);
  assert.deepEqual(originalHeaderCalls, []);

  prototype.setExtensionHeader.call(mode, undefined);

  assert.deepEqual(mode.loadedResourcesContainer.children, [loadedTheme, resourceGap]);
  assert.deepEqual(originalHeaderCalls, [undefined]);
  assert.equal(disposed, true);
});

test("a competing header clears Powerline ownership without clearing the competitor", () => {
  const originalHeaderCalls: unknown[] = [];
  const { prototype } = createPrototype(originalHeaderCalls);
  const nativeHeading = { name: "native heading" };
  const headerGap = { name: "header gap" };
  const banner = {};
  const competingFactory = () => ({ name: "competing header" });
  let powerlineOwnsWelcome = true;
  const mode = createMode(nativeHeading, headerGap);

  installPowerlineWelcomeHeaderPatch(prototype);
  prototype.setExtensionHeader.call(mode, markWelcomeFactory(
    () => banner,
    () => {
      powerlineOwnsWelcome = false;
    },
  ));
  prototype.setExtensionHeader.call(mode, competingFactory);
  if (powerlineOwnsWelcome) prototype.setExtensionHeader.call(mode, undefined);

  assert.deepEqual(mode.headerContainer.children, [nativeHeading, headerGap]);
  assert.deepEqual(mode.loadedResourcesContainer.children, []);
  assert.deepEqual(originalHeaderCalls, [competingFactory]);
  assert.equal(powerlineOwnsWelcome, false);
});

test("reinstalling the patch replaces stale header and resource wrappers", () => {
  const originalHeaderCalls: unknown[] = [];
  const { prototype } = createPrototype(originalHeaderCalls);

  installPowerlineWelcomeHeaderPatch(prototype);
  const firstHeaderWrapper = prototype.setExtensionHeader;
  const firstResourcesWrapper = prototype.showLoadedResources;
  installPowerlineWelcomeHeaderPatch(prototype);
  const secondHeaderWrapper = prototype.setExtensionHeader;
  const secondResourcesWrapper = prototype.showLoadedResources;
  secondHeaderWrapper.call({}, undefined);

  assert.notEqual(secondHeaderWrapper, firstHeaderWrapper);
  assert.notEqual(secondResourcesWrapper, firstResourcesWrapper);
  assert.deepEqual(originalHeaderCalls, [undefined]);
});
