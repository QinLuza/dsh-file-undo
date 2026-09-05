//#region src/client/follow.ts
/** 当前跟随的会话 id（null = 无会话被查看 / 两源全缺席）。 */
let followedId = null;
const listeners = /* @__PURE__ */ new Set();
/** 读取当前跟随的会话 id；面板所有请求把它作为缺省会话标识。 */
function getFollowedSessionId() {
	return followedId;
}
/** 订阅跟随会话变化；返回取消函数。 */
function subscribeFollowed(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
/** 测试钩子：重置模块级状态（验证脚本用，运行时不可达）。 */
function resetFollowedForTest() {
	followedId = null;
	bsState.available = false;
	bsState.id = null;
	seState.available = false;
	seState.id = null;
	for (const listener of Array.from(listeners)) try {
		listener();
	} catch {}
	listeners.clear();
}
function setFollowed(id) {
	if (id === followedId) return;
	followedId = id;
	for (const listener of Array.from(listeners)) try {
		listener();
	} catch {}
}
const bsState = {
	available: false,
	id: null
};
const seState = {
	available: false,
	id: null
};
function normalizeId(value) {
	return typeof value === "string" && value !== "" ? value : null;
}
/** 合并两源：betterSidebar 非空值优先，空值回落 sessions，全缺席 → null。 */
function recompute() {
	let next = null;
	if (bsState.available) next = bsState.id !== null ? bsState.id : seState.id;
	else if (seState.available) next = seState.id;
	setFollowed(next);
}
/**
* 探测并订阅 betterSidebar 主源。就绪返回 true；缺席/形态不符/读快照抛错
* 返回 false（保持「缺席」态，绝不半订阅）。
*/
function probeBetterSidebar(ctx, disposers) {
	if (bsState.available) return true;
	let svc;
	try {
		svc = ctx.get?.("betterSidebar");
	} catch {
		return false;
	}
	if (svc === void 0 || svc === null) return false;
	const getSnapshot = svc.getSnapshot;
	const subscribeState = svc.subscribeState;
	if (typeof getSnapshot !== "function" || typeof subscribeState !== "function") return false;
	let initial = null;
	try {
		const snap = getSnapshot();
		initial = snap !== null && typeof snap === "object" ? normalizeId(snap.sessionId) : null;
	} catch {
		return false;
	}
	bsState.available = true;
	bsState.id = initial;
	let dispose;
	try {
		dispose = subscribeState(() => {
			let next = null;
			try {
				const snap = getSnapshot();
				next = snap !== null && typeof snap === "object" ? normalizeId(snap.sessionId) : null;
			} catch {
				return;
			}
			bsState.id = next;
			recompute();
		});
	} catch {
		bsState.available = false;
		bsState.id = null;
		return false;
	}
	if (typeof dispose === "function") disposers.push(dispose);
	return true;
}
/** 探测并订阅 sessions.list 兜底源（同款防御纪律）。 */
function probeSessions(ctx, disposers) {
	if (seState.available) return true;
	let svc;
	try {
		svc = ctx.get?.("sessions");
	} catch {
		return false;
	}
	const list = svc === void 0 || svc === null ? void 0 : svc.list;
	if (list === void 0 || list === null) return false;
	const getSnapshot = list.getSnapshot;
	const subscribe = list.subscribe;
	if (typeof getSnapshot !== "function" || typeof subscribe !== "function") return false;
	let initial = null;
	try {
		const snap = getSnapshot();
		initial = snap !== null && typeof snap === "object" ? normalizeId(snap.current) : null;
	} catch {
		return false;
	}
	seState.available = true;
	seState.id = initial;
	let dispose;
	try {
		dispose = subscribe(() => {
			let next = null;
			try {
				const snap = getSnapshot();
				next = snap !== null && typeof snap === "object" ? normalizeId(snap.current) : null;
			} catch {
				return;
			}
			seState.id = next;
			recompute();
		});
	} catch {
		seState.available = false;
		seState.id = null;
		return false;
	}
	if (typeof dispose === "function") disposers.push(dispose);
	return true;
}
/** 未就绪源的重探上限（1.5s × 8 ≈ 12s；动态插件真机实测的同款预算）。 */
const MAX_REPROBE_TRIES = 8;
const REPROBE_INTERVAL_MS = 1500;
/**
* 安装跟随：即探即订，未就绪的源经 timer 服务有限次重探。全部缺席 → 静默
* 不跟随；插件卸载（HMR / 停用）时经 ctx.effect 统一退订。
*/
function startFollowing(ctx) {
	const disposers = [];
	const bsOk = probeBetterSidebar(ctx, disposers);
	const seOk = probeSessions(ctx, disposers);
	recompute();
	if (!(bsOk && seOk) && typeof ctx.effect === "function") {
		const timer = (() => {
			try {
				return ctx.get?.("timer");
			} catch {
				return;
			}
		})();
		if (timer !== void 0 && timer !== null && typeof timer.interval === "function") {
			const interval = timer.interval;
			let tries = 0;
			let stop;
			const tick = () => {
				tries += 1;
				const bsNow = bsOk || probeBetterSidebar(ctx, disposers);
				const seNow = seOk || probeSessions(ctx, disposers);
				recompute();
				if (bsNow && seNow || tries >= MAX_REPROBE_TRIES) try {
					stop?.();
				} catch {}
			};
			const maybeStop = interval(tick, REPROBE_INTERVAL_MS);
			stop = typeof maybeStop === "function" ? maybeStop : void 0;
			if (stop !== void 0) disposers.push(stop);
		}
	}
	if (disposers.length > 0 && typeof ctx.effect === "function") ctx.effect(() => () => {
		const list = disposers.splice(0, disposers.length);
		for (const dispose of list) try {
			dispose();
		} catch {}
	}, "follow: source subscriptions");
}
//#endregion
export { getFollowedSessionId, resetFollowedForTest, startFollowing, subscribeFollowed };
