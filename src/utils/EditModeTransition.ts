/** Creator 编辑模式对象的最小结构。 */
export interface CreatorEditMode {
	name?: string;
}

/** Creator edit-mode 模块的最小结构。 */
export interface CreatorEditModeController {
	curMode(): CreatorEditMode | null | undefined;
	pop(): void;
}

/** 退出 Prefab 编辑模式的等待参数。 */
export interface ExitPrefabModeOptions {
	pollIntervalMs?: number;
	perPopTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxPopCount?: number;
}

/** 保存完成后的稳定等待参数。 */
export interface StableModeOptions {
	pollIntervalMs?: number;
	stableMs?: number;
	timeoutMs?: number;
}

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

/** 获取当前编辑模式名称。 */
export function getEditModeName(editMode: CreatorEditModeController): string {
	const current = editMode && editMode.curMode ? editMode.curMode() : null;
	return current && typeof current.name === "string" ? current.name : "unknown";
}

/**
 * 等待保存回调后的 Prefab 模式对象稳定。
 *
 * Creator 2.4 的保存回调可能先于内部模式刷新完成。若此时立刻 pop/open，
 * 会把仍在切换的 Prefab 模式叠到编辑栈中。
 */
export async function waitForStableEditMode(
	editMode: CreatorEditModeController,
	expectedName: string,
	options: StableModeOptions = {},
): Promise<{ mode: string; waitedMs: number }> {
	const pollIntervalMs = Math.max(1, options.pollIntervalMs || 50);
	const stableMs = Math.max(pollIntervalMs, options.stableMs || 300);
	const timeoutMs = Math.max(stableMs, options.timeoutMs || 5000);
	const startedAt = Date.now();
	let stableSince = 0;
	let lastMode: CreatorEditMode | null | undefined = null;
	while (Date.now() - startedAt <= timeoutMs) {
		const current = editMode && editMode.curMode ? editMode.curMode() : null;
		const name = current && typeof current.name === "string" ? current.name : "unknown";
		if (name !== expectedName) {
			stableSince = 0;
			lastMode = current;
		} else if (current !== lastMode) {
			lastMode = current;
			stableSince = Date.now();
		} else if (stableSince && Date.now() - stableSince >= stableMs) {
			return { mode: name, waitedMs: Date.now() - startedAt };
		}
		await sleep(pollIntervalMs);
	}
	throw new Error(`等待 ${expectedName} 编辑模式稳定超时，当前模式: ${getEditModeName(editMode)}`);
}

/**
 * 逐层退出 Prefab 编辑模式，直到真正回到普通场景。
 *
 * 每次 pop 都必须观察到模式对象变化后才能继续。若 Creator 被“应用/回退”
 * 模态框阻塞，模式对象不会变化，本函数会明确失败而不会重复触发 pop。
 */
export async function exitPrefabModeToScene(
	editMode: CreatorEditModeController,
	options: ExitPrefabModeOptions = {},
): Promise<{ mode: string; popCount: number; waitedMs: number }> {
	const pollIntervalMs = Math.max(1, options.pollIntervalMs || 50);
	const perPopTimeoutMs = Math.max(pollIntervalMs, options.perPopTimeoutMs || 3000);
	const totalTimeoutMs = Math.max(perPopTimeoutMs, options.totalTimeoutMs || 12000);
	const maxPopCount = Math.max(1, options.maxPopCount || 12);
	const startedAt = Date.now();
	let popCount = 0;
	while (Date.now() - startedAt <= totalTimeoutMs) {
		const current = editMode && editMode.curMode ? editMode.curMode() : null;
		const modeName = current && typeof current.name === "string" ? current.name : "unknown";
		if (modeName === "scene") {
			return { mode: modeName, popCount, waitedMs: Date.now() - startedAt };
		}
		if (modeName !== "prefab") {
			throw new Error(`无法从未知编辑模式退出 Prefab，当前模式: ${modeName}`);
		}
		if (popCount >= maxPopCount) {
			throw new Error(`Prefab 编辑模式栈超过安全上限 ${maxPopCount} 层`);
		}
		editMode.pop();
		popCount++;
		const popStartedAt = Date.now();
		let progressed = false;
		while (Date.now() - popStartedAt <= perPopTimeoutMs && Date.now() - startedAt <= totalTimeoutMs) {
			await sleep(pollIntervalMs);
			const next = editMode.curMode();
			const nextModeName = next && typeof next.name === "string" ? next.name : "unknown";
			if (next !== current || nextModeName !== modeName) {
				progressed = true;
				break;
			}
		}
		if (!progressed) {
			throw new Error("退出 Prefab 编辑模式未取得进展，Creator 可能正被“应用/回退”弹窗阻塞");
		}
	}
	throw new Error(`退出 Prefab 编辑模式超时，当前模式: ${getEditModeName(editMode)}`);
}
