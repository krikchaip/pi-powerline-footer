import test from "node:test";
import assert from "node:assert/strict";
import { installPowerlineWelcomeHeaderPatch } from "../index.ts";

const WELCOME_HEADER_FACTORY = Symbol.for("pi-powerline-footer.welcome-header-factory");
const WELCOME_FORCE_RESOURCES = Symbol.for("pi-powerline-footer.welcome-force-resources");
const WELCOME_HEADER_REMOVED = Symbol.for("pi-powerline-footer.welcome-header-removed");

function markWelcomeFactory<T extends () => object>(
  factory: T,
  options: { forceResources?: boolean; onRemoved?: () => void } = {},
): T {
  Object.defineProperty(factory, WELCOME_HEADER_FACTORY, { value: true });
  Object.defineProperty(factory, WELCOME_FORCE_RESOURCES, { value: options.forceResources ?? true });
  if (options.onRemoved) Object.defineProperty(factory, WELCOME_HEADER_REMOVED, { value: options.onRemoved });
  return factory;
}

function createPrototype(originalHeaderCalls: unknown[]) {
  const loadedTheme = { name: "loaded theme" };
  const resourceGap = { name: "resource gap" };
  const resourceOptions: unknown[] = [];
  return {
    loadedTheme,
    resourceGap,
    resourceOptions,
    prototype: {
      setExtensionHeader(factory: unknown) {
        originalHeaderCalls.push(factory);
      },
      showLoadedResources(this: { loadedResourcesContainer: { children: unknown[] } }, options?: unknown) {
        resourceOptions.push(options);
        const force = options !== null && typeof options === "object"
          && (options as { force?: unknown }).force === true;
        this.loadedResourcesContainer.children = force ? [loadedTheme, resourceGap] : [];
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
    session: {
      resourceLoader: {
        getSystemPromptSource: () => ({ path: "/system.md" }),
        getAppendSystemPromptSources: () => [{ path: "/append.md" }],
        getAgentsFiles: () => ({ agentsFiles: [{ path: "/AGENTS.md" }] }),
        getExtensions: () => ({ extensions: [{ hidden: false }, { hidden: true }, {}] }),
        getSkills: () => ({ skills: [{}, {}] }),
      },
      promptTemplates: [{}],
    },
    ui: { requestRender() {} },
  };
}

test("welcome patch renders the banner after Pi's loaded resources", () => {
  const originalHeaderCalls: unknown[] = [];
  const { prototype, loadedTheme, resourceGap, resourceOptions } = createPrototype(originalHeaderCalls);
  const nativeHeading = { name: "native heading" };
  const headerGap = { name: "header gap" };
  let disposed = false;
  let setRequestRenderCalls = 0;
  let factoryCalls = 0;
  let factoryCounts: unknown;
  const banner = {
    dispose() {
      disposed = true;
    },
    setRequestRender(requestRender: () => void) {
      setRequestRenderCalls++;
      requestRender();
    },
  };
  const mode = createMode(nativeHeading, headerGap);

  installPowerlineWelcomeHeaderPatch(prototype);
  prototype.setExtensionHeader.call(mode, markWelcomeFactory((counts?: unknown) => {
    factoryCalls++;
    factoryCounts = counts;
    return banner;
  }));
  prototype.showLoadedResources.call(mode);

  assert.deepEqual(mode.headerContainer.children, [nativeHeading, headerGap]);
  assert.deepEqual(mode.loadedResourcesContainer.children, [loadedTheme, resourceGap, banner]);
  assert.deepEqual(resourceOptions, [{ force: true }]);
  assert.deepEqual(originalHeaderCalls, []);
  // Pi refreshes loaded resources after setHeader. The registration starts this
  // persistent component's one-shot animation only on its first attachment.
  assert.equal(setRequestRenderCalls, 1);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(factoryCounts, {
    contextFiles: 3,
    extensions: 2,
    skills: 2,
    promptTemplates: 1,
  });

  prototype.setExtensionHeader.call(mode, undefined);

  assert.deepEqual(mode.loadedResourcesContainer.children, [loadedTheme, resourceGap]);
  assert.deepEqual(originalHeaderCalls, [undefined]);
  assert.equal(disposed, true);
});

test("quiet welcome keeps the banner without forcing Pi resources", () => {
  const originalHeaderCalls: unknown[] = [];
  const { prototype, resourceOptions } = createPrototype(originalHeaderCalls);
  const banner = {};
  const mode = createMode({ name: "quiet header" }, { name: "quiet gap" });

  installPowerlineWelcomeHeaderPatch(prototype);
  prototype.setExtensionHeader.call(mode, markWelcomeFactory(
    () => banner,
    { forceResources: false },
  ));
  prototype.showLoadedResources.call(mode);

  assert.deepEqual(resourceOptions, [undefined]);
  assert.deepEqual(mode.loadedResourcesContainer.children, [banner]);
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
    {
      onRemoved: () => {
        powerlineOwnsWelcome = false;
      },
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
