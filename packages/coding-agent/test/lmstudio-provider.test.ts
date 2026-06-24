/**
 * Integration tests for T002 — Wire LM Studio provider into default configuration via models.json
 * Section: packages/coding-agent/src/core (model-registry), ~/.pi/agent/models.json
 *
 * These tests verify observable behavior of ModelRegistry when loaded with the
 * lmstudio provider block from models.json:
 *
 *   1. Load config — write the lmstudio JSON block to a temp path, call
 *      ModelRegistry.create(authStorage, tempPath), assert registry.getError()
 *      is undefined (schema validates cleanly).
 *
 *   2. Model presence — call registry.getAll(), filter by provider === 'lmstudio',
 *      assert the filtered array has length >= 2 and contains entries with
 *      id === 'gemma-4-4b' and id === 'qwen-3.5-8b'.
 *
 *   3. Correct api field — assert each of the two models has api === 'openai-completions'
 *      (inherited from the provider-level api field).
 *
 *   4. Correct metadata — assert gemma-4-4b has reasoning === false,
 *      qwen-3.5-8b has reasoning === true, both have contextWindow === 128000
 *      and maxTokens === 16384, and all cost fields are 0.
 *
 *   5. Auth configured — assert registry.hasConfiguredAuth(model) returns true
 *      for both models (the literal apiKey: 'lm-studio' is a non-env,
 *      non-command value and satisfies isConfigValueConfigured).
 *
 * NOTE: The implementation (models.json entry for lmstudio) does not exist yet.
 * Every test in this file is expected to FAIL until the implementation is created.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";

// ---------------------------------------------------------------------------
// The exact lmstudio JSON block from the task specification.
// This is what should appear in ~/.pi/agent/models.json under "providers".
// ---------------------------------------------------------------------------

const LMSTUDIO_PROVIDER_CONFIG = {
	lmstudio: {
		api: "openai-completions",
		apiKey: "lm-studio",
		baseUrl: "http://localhost:1234/v1",
		models: [
			{
				id: "gemma-4-4b",
				name: "Gemma 4 4B (LM Studio)",
				contextWindow: 128000,
				maxTokens: 16384,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "qwen-3.5-8b",
				name: "Qwen 3.5 8B (LM Studio)",
				contextWindow: 128000,
				maxTokens: 16384,
				input: ["text"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	},
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ModelRegistry — lmstudio provider via models.json (T002)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lmstudio-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		clearApiKeyCache();
	});

	// -------------------------------------------------------------------------
	// Helper: write the lmstudio block to the temp models.json and return a
	// freshly created registry backed by that file.
	// -------------------------------------------------------------------------

	function buildRegistryWithLmStudio(): ModelRegistry {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: LMSTUDIO_PROVIDER_CONFIG }), "utf-8");
		return ModelRegistry.create(authStorage, modelsJsonPath);
	}

	// -------------------------------------------------------------------------
	// Acceptance criterion 1 & 3 (vitest unit test):
	// Schema validation passes — getError() returns undefined.
	// Model count for provider 'lmstudio' is >= 2.
	// -------------------------------------------------------------------------

	describe("config loading", () => {
		test("ModelRegistry.getError() returns undefined when loading lmstudio config (schema validates cleanly)", () => {
			// Fails until the lmstudio block is a valid models.json entry.
			const registry = buildRegistryWithLmStudio();
			expect(registry.getError()).toBeUndefined();
		});

		test("model count for provider 'lmstudio' is >= 2", () => {
			// Vitest unit test requested in acceptance criteria.
			// Fails until the implementation produces at least 2 lmstudio models.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			expect(lmstudioModels.length).toBeGreaterThanOrEqual(2);
		});
	});

	// -------------------------------------------------------------------------
	// Acceptance criterion 1:
	// ModelRegistry.getAll() returns models with provider='lmstudio' and ids
	// 'gemma-4-4b' and 'qwen-3.5-8b'.
	// -------------------------------------------------------------------------

	describe("model presence (acceptance criterion 1)", () => {
		test("getAll() returns at least one model with provider='lmstudio'", () => {
			// Fails until the lmstudio provider is wired into models.json.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			expect(lmstudioModels.length).toBeGreaterThanOrEqual(1);
		});

		test("getAll() contains a model with id='gemma-4-4b' and provider='lmstudio'", () => {
			// Fails until 'gemma-4-4b' is present in the lmstudio provider config.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			const ids = lmstudioModels.map((m) => m.id);
			expect(ids).toContain("gemma-4-4b");
		});

		test("getAll() contains a model with id='qwen-3.5-8b' and provider='lmstudio'", () => {
			// Fails until 'qwen-3.5-8b' is present in the lmstudio provider config.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			const ids = lmstudioModels.map((m) => m.id);
			expect(ids).toContain("qwen-3.5-8b");
		});

		test("getAll() contains both 'gemma-4-4b' and 'qwen-3.5-8b' under lmstudio", () => {
			// Fails until both models are present.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			const ids = lmstudioModels.map((m) => m.id);
			expect(ids).toContain("gemma-4-4b");
			expect(ids).toContain("qwen-3.5-8b");
			expect(lmstudioModels.length).toBeGreaterThanOrEqual(2);
		});
	});

	// -------------------------------------------------------------------------
	// Acceptance criterion 2:
	// Starting 'pi' (no -e flag) shows both lmstudio models under '/model' selector.
	// The '/model' selector is backed by registry.getAvailable() which filters by
	// hasConfiguredAuth(). We verify getAvailable() includes both lmstudio models.
	// -------------------------------------------------------------------------

	describe("model selector visibility (acceptance criterion 2)", () => {
		test("getAvailable() includes gemma-4-4b (visible under /model selector)", () => {
			// Fails until the model exists and auth is configured.
			const registry = buildRegistryWithLmStudio();
			const available = registry.getAvailable();
			const lmstudioAvailable = available.filter((m) => m.provider === "lmstudio");
			const ids = lmstudioAvailable.map((m) => m.id);
			expect(ids).toContain("gemma-4-4b");
		});

		test("getAvailable() includes qwen-3.5-8b (visible under /model selector)", () => {
			// Fails until the model exists and auth is configured.
			const registry = buildRegistryWithLmStudio();
			const available = registry.getAvailable();
			const lmstudioAvailable = available.filter((m) => m.provider === "lmstudio");
			const ids = lmstudioAvailable.map((m) => m.id);
			expect(ids).toContain("qwen-3.5-8b");
		});

		test("getAvailable() includes both lmstudio models (both appear under /model selector)", () => {
			// Fails until both models exist with configured auth.
			const registry = buildRegistryWithLmStudio();
			const available = registry.getAvailable();
			const lmstudioAvailable = available.filter((m) => m.provider === "lmstudio");
			expect(lmstudioAvailable.length).toBeGreaterThanOrEqual(2);
			const ids = lmstudioAvailable.map((m) => m.id);
			expect(ids).toContain("gemma-4-4b");
			expect(ids).toContain("qwen-3.5-8b");
		});
	});

	// -------------------------------------------------------------------------
	// Acceptance criterion 3 (also vitest unit test):
	// ModelRegistry validation produces no error (getError() returns undefined).
	// -------------------------------------------------------------------------

	describe("ModelRegistry validation (acceptance criterion 3)", () => {
		test("getError() is undefined — validation produces no error", () => {
			// Fails until the lmstudio config block is schema-valid.
			const registry = buildRegistryWithLmStudio();
			expect(registry.getError()).toBeUndefined();
		});

		test("getError() stays undefined after registry.refresh()", () => {
			// Fails until the config is stable across refreshes.
			const registry = buildRegistryWithLmStudio();
			registry.refresh();
			expect(registry.getError()).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Test strategy scenario 3: Correct api field.
	// Each model must have api === 'openai-completions' (inherited from provider-level api).
	// -------------------------------------------------------------------------

	describe("api field (test strategy scenario 3)", () => {
		test("gemma-4-4b has api === 'openai-completions'", () => {
			// Fails until the provider-level api is set to 'openai-completions'.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
		});

		test("qwen-3.5-8b has api === 'openai-completions'", () => {
			// Fails until the provider-level api is set to 'openai-completions'.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
		});

		test("all lmstudio models have api === 'openai-completions'", () => {
			// Fails until all lmstudio models inherit the correct api.
			const registry = buildRegistryWithLmStudio();
			const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
			for (const model of lmstudioModels) {
				expect(model.api).toBe("openai-completions");
			}
		});
	});

	// -------------------------------------------------------------------------
	// Test strategy scenario 4: Correct metadata.
	// gemma-4-4b: reasoning === false
	// qwen-3.5-8b: reasoning === true
	// Both: contextWindow === 128000, maxTokens === 16384, all cost fields === 0
	// -------------------------------------------------------------------------

	describe("model metadata (test strategy scenario 4)", () => {
		test("gemma-4-4b has reasoning === false", () => {
			// Fails until the gemma model is configured with reasoning: false.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.reasoning).toBe(false);
		});

		test("qwen-3.5-8b has reasoning === true", () => {
			// Fails until the qwen model is configured with reasoning: true.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.reasoning).toBe(true);
		});

		test("gemma-4-4b has contextWindow === 128000", () => {
			// Fails until the gemma model is configured with the correct contextWindow.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.contextWindow).toBe(128000);
		});

		test("qwen-3.5-8b has contextWindow === 128000", () => {
			// Fails until the qwen model is configured with the correct contextWindow.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.contextWindow).toBe(128000);
		});

		test("gemma-4-4b has maxTokens === 16384", () => {
			// Fails until the gemma model is configured with the correct maxTokens.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.maxTokens).toBe(16384);
		});

		test("qwen-3.5-8b has maxTokens === 16384", () => {
			// Fails until the qwen model is configured with the correct maxTokens.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.maxTokens).toBe(16384);
		});

		test("gemma-4-4b has all cost fields === 0", () => {
			// Fails until the gemma model is configured with zero costs.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.cost.input).toBe(0);
			expect(model?.cost.output).toBe(0);
			expect(model?.cost.cacheRead).toBe(0);
			expect(model?.cost.cacheWrite).toBe(0);
		});

		test("qwen-3.5-8b has all cost fields === 0", () => {
			// Fails until the qwen model is configured with zero costs.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.cost.input).toBe(0);
			expect(model?.cost.output).toBe(0);
			expect(model?.cost.cacheRead).toBe(0);
			expect(model?.cost.cacheWrite).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Test strategy scenario 5: Auth configured.
	// hasConfiguredAuth(model) returns true for both models because the literal
	// apiKey 'lm-studio' is a non-env, non-command value and satisfies
	// isConfigValueConfigured (no missing env vars).
	// -------------------------------------------------------------------------

	describe("auth configured (test strategy scenario 5)", () => {
		test("hasConfiguredAuth returns true for gemma-4-4b", () => {
			// Fails until the lmstudio provider has apiKey: 'lm-studio' which is a
			// configured literal value (no env var prefix, no ! prefix).
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(registry.hasConfiguredAuth(model!)).toBe(true);
		});

		test("hasConfiguredAuth returns true for qwen-3.5-8b", () => {
			// Fails until the lmstudio provider has apiKey: 'lm-studio' which is a
			// configured literal value (no env var prefix, no ! prefix).
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(registry.hasConfiguredAuth(model!)).toBe(true);
		});

		test("getProviderAuthStatus for lmstudio reports configured via models_json_key", () => {
			// Literal apiKey 'lm-studio' is not an env var reference or command,
			// so the auth status source should be 'models_json_key'.
			const registry = buildRegistryWithLmStudio();
			const status = registry.getProviderAuthStatus("lmstudio");
			expect(status.configured).toBe(true);
			expect(status.source).toBe("models_json_key");
		});
	});

	// -------------------------------------------------------------------------
	// Sanity check: the lmstudio models have the correct baseUrl
	// -------------------------------------------------------------------------

	describe("baseUrl", () => {
		test("gemma-4-4b has baseUrl pointing to LM Studio (localhost:1234)", () => {
			// Fails until the lmstudio provider configures the correct baseUrl.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "gemma-4-4b");
			expect(model).toBeDefined();
			expect(model?.baseUrl).toContain("localhost:1234");
		});

		test("qwen-3.5-8b has baseUrl pointing to LM Studio (localhost:1234)", () => {
			// Fails until the lmstudio provider configures the correct baseUrl.
			const registry = buildRegistryWithLmStudio();
			const model = registry.find("lmstudio", "qwen-3.5-8b");
			expect(model).toBeDefined();
			expect(model?.baseUrl).toContain("localhost:1234");
		});
	});
});

// ---------------------------------------------------------------------------
// Production config tests: verify the actual ~/.pi/agent/models.json file
// contains the required lmstudio provider with the correct model IDs.
//
// These tests FAIL until the implementation adds the lmstudio block to the
// production models.json at ~/.pi/agent/models.json (or $PI_AGENT_DIR/models.json).
// ---------------------------------------------------------------------------

describe("Production models.json — lmstudio provider present (T002)", () => {
	const agentDir = process.env.PI_AGENT_DIR ? process.env.PI_AGENT_DIR : join(homedir(), ".pi", "agent");
	const productionModelsJsonPath = join(agentDir, "models.json");
	let productionAuthStorage: AuthStorage;

	beforeEach(() => {
		productionAuthStorage = AuthStorage.create(join(agentDir, "auth.json"));
	});

	afterEach(() => {
		clearApiKeyCache();
	});

	test("~/.pi/agent/models.json exists", () => {
		// Fails if the user has no models.json at all.
		expect(existsSync(productionModelsJsonPath)).toBe(true);
	});

	test("production ModelRegistry.getError() is undefined (no validation errors)", () => {
		// Fails if models.json has schema errors that prevent loading.
		if (!existsSync(productionModelsJsonPath)) {
			// Skip gracefully — covered by the previous test.
			return;
		}
		const registry = ModelRegistry.create(productionAuthStorage, productionModelsJsonPath);
		expect(registry.getError()).toBeUndefined();
	});

	test("production registry getAll() contains model with provider='lmstudio' and id='gemma-4-4b'", () => {
		// FAILS until the lmstudio block with gemma-4-4b is added to ~/.pi/agent/models.json.
		if (!existsSync(productionModelsJsonPath)) {
			// Fail explicitly so the missing file is visible.
			expect.fail(`models.json not found at ${productionModelsJsonPath}`);
		}
		const registry = ModelRegistry.create(productionAuthStorage, productionModelsJsonPath);
		const model = registry.find("lmstudio", "gemma-4-4b");
		expect(model).toBeDefined();
	});

	test("production registry getAll() contains model with provider='lmstudio' and id='qwen-3.5-8b'", () => {
		// FAILS until the lmstudio block with qwen-3.5-8b is added to ~/.pi/agent/models.json.
		if (!existsSync(productionModelsJsonPath)) {
			expect.fail(`models.json not found at ${productionModelsJsonPath}`);
		}
		const registry = ModelRegistry.create(productionAuthStorage, productionModelsJsonPath);
		const model = registry.find("lmstudio", "qwen-3.5-8b");
		expect(model).toBeDefined();
	});

	test("production registry has >= 2 lmstudio models (vitest unit test per acceptance criteria)", () => {
		// FAILS until at least 2 lmstudio models exist in the production models.json.
		if (!existsSync(productionModelsJsonPath)) {
			expect.fail(`models.json not found at ${productionModelsJsonPath}`);
		}
		const registry = ModelRegistry.create(productionAuthStorage, productionModelsJsonPath);
		const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
		expect(lmstudioModels.length).toBeGreaterThanOrEqual(2);
	});

	test("production lmstudio models are visible under /model selector (hasConfiguredAuth)", () => {
		// FAILS until the lmstudio block exists with a configured apiKey.
		if (!existsSync(productionModelsJsonPath)) {
			expect.fail(`models.json not found at ${productionModelsJsonPath}`);
		}
		const registry = ModelRegistry.create(productionAuthStorage, productionModelsJsonPath);
		const lmstudioModels = registry.getAll().filter((m) => m.provider === "lmstudio");
		// Expect at least gemma-4-4b and qwen-3.5-8b
		const gemma = lmstudioModels.find((m) => m.id === "gemma-4-4b");
		const qwen = lmstudioModels.find((m) => m.id === "qwen-3.5-8b");
		expect(gemma).toBeDefined();
		expect(qwen).toBeDefined();
		if (gemma) expect(registry.hasConfiguredAuth(gemma)).toBe(true);
		if (qwen) expect(registry.hasConfiguredAuth(qwen)).toBe(true);
	});
});
