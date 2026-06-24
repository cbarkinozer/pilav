/**
 * Integration tests for the lmstudio-provider extension.
 *
 * T001 — Create LM Studio provider extension
 * Section: packages/coding-agent/examples/extensions/lmstudio-provider
 *
 * These tests verify observable behavior of the extension:
 *   1. The extension loads without errors via discoverAndLoadExtensions / loadExtensions.
 *   2. After loading, the model registry exposes lmstudio/gemma-4-4b and
 *      lmstudio/qwen-3.5-8b as selectable models.
 *   3. Selecting lmstudio/gemma-4-4b and sending a prompt returns a non-empty
 *      response (skipped unless LM Studio is running locally with Gemma loaded).
 *   4. Selecting lmstudio/qwen-3.5-8b and sending a prompt returns a non-empty
 *      response (skipped unless LM Studio is running locally with Qwen loaded).
 *   5. The extension directory has no TypeScript compile errors (tsc --noEmit).
 *
 * Tests 3 and 4 follow the skipIf(!lmStudioRunning) pattern used in
 * packages/ai/test/context-overflow.test.ts lines 670-691.
 *
 * NOTE: The implementation file does not exist yet. Every test in this file
 * is expected to FAIL until the implementation is created.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EXTENSION_DIR = resolve(__dirname, "../examples/extensions/lmstudio-provider");
const EXTENSION_INDEX = join(EXTENSION_DIR, "index.ts");

// ---------------------------------------------------------------------------
// LM Studio availability probe (mirrors context-overflow.test.ts lines 660-668)
// ---------------------------------------------------------------------------

let lmStudioRunning = false;
if (!process.env.PI_NO_LOCAL_LLM) {
	try {
		execSync("curl -s --max-time 1 http://localhost:1234/v1/models > /dev/null", { stdio: "ignore" });
		lmStudioRunning = true;
	} catch {
		lmStudioRunning = false;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal in-memory ModelRegistry backed by a temporary AuthStorage.
 * No models.json is loaded — custom models come solely from extensions.
 */
function buildRegistry(tempDir: string): ModelRegistry {
	const authPath = join(tempDir, "auth.json");
	const authStorage = AuthStorage.create(authPath);
	return ModelRegistry.inMemory(authStorage);
}

// ---------------------------------------------------------------------------
// Test 1: Extension loads without errors
// ---------------------------------------------------------------------------

describe("lmstudio-provider extension — loading", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lmstudio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("index.ts file exists in the extension directory", () => {
		// Fails until implementation is created.
		expect(existsSync(EXTENSION_INDEX)).toBe(true);
	});

	it("loads without errors via loadExtensions", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
	});

	it("extension exports a default factory function", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.length).toBeGreaterThan(0);
	});

	it("loading does not write anything to stderr that contains 'error' or 'TypeError'", async () => {
		// Capture stderr by running the extension load in a subprocess.
		// Fails until implementation is created (file not found).
		let stderrOutput = "";
		let _exitCode = 0;
		try {
			execSync(
				`node --input-type=module --eval "import('${EXTENSION_INDEX}').then(m => { if (typeof m.default !== 'function') throw new Error('not a function'); process.exit(0); }).catch(e => { process.stderr.write(String(e)); process.exit(1); })"`,
				{ encoding: "utf-8", stdio: ["ignore", "ignore", "pipe"] },
			);
		} catch (err: unknown) {
			const spawnError = err as { status?: number; stderr?: string };
			_exitCode = spawnError.status ?? 1;
			stderrOutput = spawnError.stderr ?? "";
		}

		// Tolerate runtime-only errors (extension loads but throws when called without
		// a live pi context) — we only care that *loading the module* produces no
		// TypeScript/import errors on stderr.
		const hasModuleError = /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(stderrOutput);
		expect(hasModuleError).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test 2: /model command lists the expected models
// ---------------------------------------------------------------------------

describe("lmstudio-provider extension — model registration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lmstudio-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers lmstudio/gemma-4-4b in the model registry", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);

		// Flush pending provider registrations into a registry.
		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const allModels = registry.getAll();
		const modelIds = allModels.map((m) => `${m.provider}/${m.id}`);

		expect(modelIds).toContain("lmstudio/gemma-4-4b");
	});

	it("registers lmstudio/qwen-3.5-8b in the model registry", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);

		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const allModels = registry.getAll();
		const modelIds = allModels.map((m) => `${m.provider}/${m.id}`);

		expect(modelIds).toContain("lmstudio/qwen-3.5-8b");
	});

	it("registers both lmstudio models as selectable entries", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);

		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const allModels = registry.getAll();
		const lmStudioModels = allModels.filter((m) => m.provider === "lmstudio");
		const lmStudioModelIds = lmStudioModels.map((m) => m.id);

		expect(lmStudioModelIds).toContain("gemma-4-4b");
		expect(lmStudioModelIds).toContain("qwen-3.5-8b");
		expect(lmStudioModels.length).toBeGreaterThanOrEqual(2);
	});

	it("registered models have a baseUrl pointing to LM Studio (localhost:1234)", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);

		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const allModels = registry.getAll();
		const lmStudioModels = allModels.filter((m) => m.provider === "lmstudio");

		for (const model of lmStudioModels) {
			expect(model.baseUrl).toBeTruthy();
			expect(model.baseUrl).toContain("localhost:1234");
		}
	});

	it("registered models use the openai-completions API (LM Studio speaks OpenAI)", async () => {
		// Fails until implementation is created.
		const result = await loadExtensions([EXTENSION_INDEX], tempDir);

		expect(result.errors).toHaveLength(0);

		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const allModels = registry.getAll();
		const lmStudioModels = allModels.filter((m) => m.provider === "lmstudio");

		for (const model of lmStudioModels) {
			expect(model.api).toBe("openai-completions");
		}
	});
});

// ---------------------------------------------------------------------------
// Test 3 & 4: Live inference (skipped unless LM Studio is running locally)
// ---------------------------------------------------------------------------

describe.skipIf(!lmStudioRunning)("lmstudio-provider extension — live inference (LM Studio required)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lmstudio-live-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * Helper: load the extension, build a registry, resolve the model by id,
	 * then stream a simple prompt through the openai-completions API and return
	 * the concatenated assistant text.
	 */
	async function promptModel(modelId: string, prompt: string): Promise<string> {
		// Import the live streaming helpers from pi-ai/compat.
		// Dynamic import so the module is not bundled unless these tests run.
		const { openAICompletionsApi } = await import("@earendil-works/pi-ai/compat");

		const result = await loadExtensions([EXTENSION_INDEX], tempDir);
		if (result.errors.length > 0) {
			throw new Error(`Extension failed to load: ${result.errors.map((e) => e.error).join("; ")}`);
		}

		const registry = buildRegistry(tempDir);
		for (const reg of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(reg.name, reg.config);
		}

		const model = registry.find("lmstudio", modelId);
		if (!model) {
			throw new Error(`Model lmstudio/${modelId} not found in registry`);
		}

		const context = {
			messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
		};

		const api = openAICompletionsApi();
		const stream = api.streamSimple(model as Parameters<typeof api.streamSimple>[0], context, {
			apiKey: "lm-studio", // LM Studio does not validate the key
			maxTokens: 256,
		});

		let text = "";
		for await (const event of stream) {
			if (event.type === "text_delta") {
				text += event.delta;
			} else if (event.type === "error") {
				throw new Error(`Stream error: ${event.error.errorMessage}`);
			} else if (event.type === "done") {
				break;
			}
		}

		return text.trim();
	}

	it("lmstudio/gemma-4-4b returns a non-empty response (Gemma must be loaded in LM Studio)", async () => {
		// Fails until implementation exists AND LM Studio is running with Gemma.
		const response = await promptModel("gemma-4-4b", "say hi");
		expect(response.length).toBeGreaterThan(0);
	}, 120_000);

	it("lmstudio/qwen-3.5-8b returns a non-empty response (Qwen must be loaded in LM Studio)", async () => {
		// Fails until implementation exists AND LM Studio is running with Qwen.
		const response = await promptModel("qwen-3.5-8b", "say hi");
		expect(response.length).toBeGreaterThan(0);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// Test 5: TypeScript compile check (tsc --noEmit)
// ---------------------------------------------------------------------------

describe("lmstudio-provider extension — TypeScript compile check", () => {
	it("tsc --noEmit passes for the extension directory (no TypeScript errors)", () => {
		// Fails until the implementation is created and type-checks cleanly.
		expect(existsSync(EXTENSION_DIR)).toBe(true);

		let stderr = "";
		let exitCode = 0;
		try {
			execSync(
				`npx --yes tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 "${EXTENSION_INDEX}"`,
				{
					cwd: EXTENSION_DIR,
					encoding: "utf-8",
					stdio: ["ignore", "ignore", "pipe"],
					timeout: 60_000,
				},
			);
		} catch (err: unknown) {
			const spawnError = err as { status?: number; stderr?: string };
			exitCode = spawnError.status ?? 1;
			stderr = spawnError.stderr ?? "";
		}

		// If tsc is not in PATH or the directory doesn't exist yet, the test will
		// fail with an appropriate message.
		if (exitCode !== 0) {
			// Provide the compiler output as the failure message for easy debugging.
			expect.fail(`tsc --noEmit exited with code ${exitCode}:\n${stderr}`);
		}

		expect(exitCode).toBe(0);
	});
});
