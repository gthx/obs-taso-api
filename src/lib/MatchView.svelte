<script>
    import { onMount } from "svelte";
    import {
        obsWebSocket,
        connectionStatus,
        matchData,
    } from "./obsWebSocket.js";
    import { torneopalApi } from "./torneopalApi.js";
    import NumericInput from "./NumericInput.svelte";

    // Read matchId from URL params
    const matchId = new URLSearchParams(window.location.search).get("matchId");

    // Read OBS settings from localStorage
    let wsUrl = localStorage.getItem("obs-ws-url") || "ws://localhost:4455";
    let wsPassword = localStorage.getItem("obs-ws-password") || "";

    // Read API key from localStorage
    let torneopalApiKey = torneopalApi.getStoredApiKey();
    let torneopalEnabled = $derived(
        torneopalApiKey && matchId && !torneopalApi.isLocalMatch(matchId),
    );

    let isConnecting = $state(false);

    // Score control state
    let scoreMode = $state("auto"); // "auto" or "manual"
    let apiScores = $state(/** @type {any} */ (null));

    // Time control state
    let timeMode = $state("auto"); // "auto", "manual", or "period"

    // Global timer state. In manual mode this is the overlay clock; in auto
    // mode it gates the score polling (paused = no requests, overlay frozen on
    // the last value pushed). Either way it means "the clock on air is moving".
    let globalTimerActive = $state(false);

    // Score polling state. getScore is never cached and may be polled at most
    // once per second, so that is exactly the rate we use.
    const POLL_INTERVAL_MS = 1000;

    // Nothing on air changes during an intermission, so polling stops for the
    // duration. The countdown itself brings it back, which is why the break
    // panel can pause it safely where a manual pause could not.
    const BREAK_POLL_RESUME_SEC = 5;

    // How long the official clock has to run before the panel comes off air
    const BREAK_AUTOHIDE_MS = 2000;
    // Torneopal carries no intermission length (period_sec and
    // period_lengths_sec are playing time only, and p*_start_time/p*_end_time
    // come back empty), so these are fixed defaults. Each press starts fresh;
    // the time field adjusts the running countdown only.
    const DEFAULT_BREAK_SECONDS = 15 * 60;
    const POWER_BREAK_SECONDS = 60;
    let isPollingScores = $state(false);
    let pollError = $state("");
    let lastPollAt = $state(null);
    let isFetchingScore = false;

    // Auto clock state: the API is the source of truth, so the time is set
    // absolutely on every poll and may jump backwards.
    let apiSeconds = $state(null);
    let apiTimerOn = $state(false);
    let apiPeriod = $state(/** @type {number | null} */ (null));

    // Torneopal advances live_period the moment the previous period is
    // confirmed over, and resets live_time with it. Taken at face value that
    // puts "3rd 00:00" on air for the whole intermission, so the previous
    // period is held at its end time until the clock actually starts.
    let heldAtPeriodEnd = $state(false);
    let lastAutoKey = "";

    // Manual trim on top of the computed clock (seconds). Auto mode only -
    // the manual clock is never affected by this. Latency can only make us
    // late, never early, so the correction is forward-only.
    const MAX_DRIFT = 5;
    let driftOffset = $state(0);

    // Exact clock. getScore reports when the running clock was started
    // (live_timer_start) and the playing time at that moment
    // (live_timer_start_time), so the current playing time is arithmetic
    // instead of a 1 s-quantised sample that is already stale on arrival.
    let anchorWallMs = $state(/** @type {number | null} */ (null));
    let anchorSeconds = $state(/** @type {number | null} */ (null));
    let apiReceivedAtMs = $state(/** @type {number | null} */ (null));
    let nowMs = $state(Date.now());

    // live_timer_start is a server timestamp with no zone, so it is read as
    // local time. Any disagreement between this machine's clock and the
    // server's turns up here: it is measured, shown in the header and
    // corrected for, so the overlay only ever receives a finished time.
    const MAX_TRUSTED_SKEW_MS = 60000;
    const SKEW_SAMPLE_COUNT = 10;
    let skewSamples = $state(/** @type {number[]} */ ([]));
    let clockSkewMs = $state(/** @type {number | null} */ (null));
    let lastRttMs = $state(/** @type {number | null} */ (null));

    let skewTrusted = $derived(
        clockSkewMs !== null && Math.abs(clockSkewMs) <= MAX_TRUSTED_SKEW_MS,
    );

    // The exact computation drives the clock only when the official clock is
    // running and we have a trustworthy anchor to compute from.
    let usingExactClock = $derived(
        apiTimerOn &&
            skewTrusted &&
            anchorWallMs !== null &&
            anchorSeconds !== null,
    );

    // Whole seconds since the reading we are bounded by arrived
    let sampleAgeSeconds = $derived(
        apiReceivedAtMs === null
            ? 0
            : Math.floor(Math.max(0, nowMs - apiReceivedAtMs) / 1000),
    );

    function clampToPeriod(seconds) {
        const periodLength = periodLengths[period] || 0;
        const floored = Math.max(0, seconds);
        return periodLength > 0 ? Math.min(floored, periodLength) : floored;
    }

    // The time actually put on air. A stopped clock reports an exact value
    // that is not going stale, so there is nothing to correct while it is off.
    let effectiveSeconds = $derived.by(() => {
        if (heldAtPeriodEnd) return periodLengths[period] || 0;
        if (!apiTimerOn) return apiSeconds;

        if (usingExactClock) {
            const elapsedMs = nowMs + clockSkewMs - anchorWallMs;
            const computed = anchorSeconds + Math.floor(elapsedMs / 1000);

            // live_time, live_timer_start and live_timer_start_time all carry
            // one-second resolution, so the API exposes no sub-second phase at
            // all: anticipating the boundary can only put a second on air that
            // the official display has not reached yet. The computation fills
            // gaps between polls, but never leads what the server reported.
            const bounded =
                apiSeconds === null
                    ? computed
                    : Math.min(
                          Math.max(computed, apiSeconds),
                          apiSeconds + sampleAgeSeconds,
                      );

            return clampToPeriod(bounded + driftOffset);
        }

        // No usable anchor: fall back to the reported time
        if (apiSeconds === null) return null;
        return clampToPeriod(apiSeconds + driftOffset);
    });

    let lastPollLabel = $derived(
        lastPollAt ? new Date(lastPollAt).toLocaleTimeString() : "never",
    );

    // Time override functionality
    let overrideTime = $state("");
    let isTimeOverrideActive = $state(false);

    // Match info
    let matchInfo = $state(null);
    let periodLengths = [0, 1200, 1200, 1200, 300, 0, 0];

    // Penalty state
    let homePenalties = $state([]);
    let awayPenalties = $state([]);
    let penaltyIdCounter = $state(1);

    // Shootout state
    let homeShootout = $state([]);
    let awayShootout = $state([]);

    // Intermission panel. The countdown is anchored to a wall-clock instant so
    // it cannot drift, and the operator types the remaining time the same way
    // as the manual game clock.
    let breakActive = $state(false);
    let breakEndsAtMs = $state(/** @type {number | null} */ (null));
    let breakInput = $state("");
    let breakKind = $state("intermission"); // "intermission" or "powerbreak"
    let breakInputActive = $state(false);
    let gameResumedAtMs = $state(/** @type {number | null} */ (null));
    let lastBreakKey = "";

    // Result plansi. The PSD's tab layer reads "LOPPUTULOS" - the "RESULT" in
    // the Havainnekuva render is that render's own wording, and the rest of
    // the overlay is Finnish. A plain string if it ever has to say otherwise.
    const RESULT_TAB_TEXT = "LOPPUTULOS";
    let resultActive = $state(false);

    let breakRemaining = $derived(
        breakEndsAtMs === null
            ? 0
            : Math.max(0, Math.ceil((breakEndsAtMs - nowMs) / 1000)),
    );

    // A boolean rather than the remaining seconds, so the polling effect is
    // not torn down and restarted on every tick
    let breakPausesPolling = $derived(
        breakActive && breakRemaining > BREAK_POLL_RESUME_SEC,
    );

    // Key repeat protection
    let lastKeyPress = 0;
    const keyDebounceDelay = 150;

    // Local copy of match data for form binding
    let homeTeamName = $state("");
    let homeTeamScore = $state(0);
    let awayTeamName = $state("");
    let awayTeamScore = $state(0);
    let period = $state(1);
    let time = $state("00:00");

    // The wordmark carries the period it belongs to: "1. ERÄTAUKO" after the
    // first period, "3. POWER BREAK" during the third. During an intermission
    // `period` is already held at the one that just ended.
    let breakLabel = $derived(
        `${formatPeriodLabel(period)} ${
            breakKind === "powerbreak" ? "POWER BREAK" : "ERÄTAUKO"
        }`,
    );

    // Track what the overlay currently has (last sent via ClockControl)
    let overlayHomeScore = $state(0);
    let overlayAwayScore = $state(0);
    let overlayPeriod = $state(1);

    // Dirty flag: local state differs from overlay
    let scoreDirty = $derived(
        homeTeamScore !== overlayHomeScore ||
            awayTeamScore !== overlayAwayScore ||
            period !== overlayPeriod,
    );

    // Subscribe to match data changes using $effect
    $effect(() => {
        if ($matchData) {
            if ($matchData.homeTeam?.name)
                homeTeamName = $matchData.homeTeam?.name;
            if ($matchData.homeTeam?.score)
                homeTeamScore = $matchData.homeTeam?.score;
            if ($matchData.awayTeam?.name)
                awayTeamName = $matchData.awayTeam?.name;
            if ($matchData.awayTeam?.score)
                awayTeamScore = $matchData.awayTeam?.score;
            if ($matchData.period) period = $matchData.period;
            if ($matchData.time) time = $matchData.time;
        }
    });

    // Helper: send ClockControl with current score+period bundled
    function sendClockWithState(action, extraData = {}) {
        const payload = {
            homeScore: homeTeamScore,
            awayScore: awayTeamScore,
            period,
            periodLength: periodLengths[period],
            ...extraData,
        };
        obsWebSocket.sendClockControl(action, payload);

        // Update overlay tracking state
        overlayHomeScore = homeTeamScore;
        overlayAwayScore = awayTeamScore;
        overlayPeriod = period;
    }

    // In "period" mode there is no clock, so there are no clock events to carry
    // the score to the overlay. Push score changes straight through instead.
    $effect(() => {
        const home = homeTeamScore;
        const away = awayTeamScore;
        if (timeMode !== "period" || $connectionStatus !== "connected") return;

        obsWebSocket.sendScoreUpdate(home, away);
        overlayHomeScore = home;
        overlayAwayScore = away;
    });

    // Handle time sync from overlay (scoreboard is source of truth for time)
    function handleClockSync(data) {
        if (data.time) {
            time = data.time;
        }

        // Auto-advance period if time reached period end (local only, propagates on next clock_start)
        if (!globalTimerActive && data.seconds !== undefined) {
            const periodLen = periodLengths[period];
            if (periodLen > 0 && data.seconds >= periodLen && period <= 4) {
                period = nextPeriod(period);
                time = "00:00";
            }
        }
    }

    // Change period directly (from dropdown)
    function changePeriod(newPeriod) {
        period = newPeriod;
        time = "00:00";
        globalTimerActive = false;
        if ($connectionStatus === "connected") {
            sendClockWithState("period_change", {
                periodLength: periodLengths[period],
            });
        }
    }

    async function connect() {
        isConnecting = true;
        try {
            await obsWebSocket.connect(wsUrl, wsPassword);
            await obsWebSocket.getMatchData();

            // Listen for clock sync from overlay
            obsWebSocket.addEventListener("CustomEvent", (event) => {
                if (event.eventData) {
                    const { eventName, eventData } = event.eventData;
                    if (eventName === "ClockControl" && eventData.action === "clock_sync") {
                        handleClockSync(eventData);
                    }
                }
            });
        } catch (error) {
            console.error("Connection failed:", error);
        } finally {
            isConnecting = false;
        }
    }

    function disconnect() {
        obsWebSocket.disconnect();
    }

    // Score control functions
    function setScoreMode(mode) {
        scoreMode = mode;
        localStorage.setItem("score-mode", mode);
    }

    // Time control functions
    function setTimeMode(mode) {
        const previous = timeMode;
        timeMode = mode;
        localStorage.setItem("time-mode", mode);

        if (previous !== "auto" && mode === "auto") {
            // The API feed runs by default
            globalTimerActive = true;
        } else if (previous === "auto" && mode !== "auto") {
            globalTimerActive = false;
        }
        lastAutoKey = "";

        updateMatchData();
    }

    // Drift functions - auto mode only
    function setDrift(value) {
        driftOffset = value;
        if (matchId) {
            localStorage.setItem(`drift-offset-${matchId}`, String(value));
        }
        applyAutoClock();
    }

    function adjustDrift(delta) {
        setDrift(Math.min(MAX_DRIFT, Math.max(0, driftOffset + delta)));
    }

    function resetDrift() {
        setDrift(0);
    }

    function formatDrift(value) {
        return `${value > 0 ? "+" : ""}${value}s`;
    }

    let driftTitle = $derived.by(() => {
        if (effectiveSeconds === null) return "Waiting for API time";
        if (heldAtPeriodEnd) {
            return `Intermission — period ${period} held at ${formatAbsoluteTime(effectiveSeconds)}`;
        }
        if (!apiTimerOn) {
            return `Clock stopped — API ${formatAbsoluteTime(apiSeconds)} used as is, no latency to correct`;
        }
        const source = usingExactClock ? "Computed" : "Reported live_time";
        return `${source} + ${driftOffset}s → overlay ${formatAbsoluteTime(effectiveSeconds)}`;
    });

    // How far the time on air is from the reading the server gave us
    let leadSeconds = $derived(
        apiSeconds === null || effectiveSeconds === null
            ? 0
            : effectiveSeconds - apiSeconds,
    );

    let syncLabel = $derived.by(() => {
        if (clockSkewMs === null) return "Sync ?";
        if (!skewTrusted) return "Sync off";

        const sign = clockSkewMs < 0 ? "−" : "+";
        return `Sync ${sign}${(Math.abs(clockSkewMs) / 1000).toFixed(1)}s`;
    });

    let syncTitle = $derived.by(() => {
        if (clockSkewMs === null) {
            return "Server clock offset is measured while the official clock runs";
        }

        const lines = [
            `Server clock − this machine: ${(clockSkewMs / 1000).toFixed(2)}s`,
            `${skewSamples.length}/${SKEW_SAMPLE_COUNT} samples, round trip ${lastRttMs}ms`,
        ];

        if (!skewTrusted) {
            lines.push(
                `Beyond ±${MAX_TRUSTED_SKEW_MS / 1000}s — falling back to the reported live_time.`,
                "Check this machine's clock and the time zone of live_timer_start.",
            );
        } else if (usingExactClock) {
            lines.push(
                `Anchored at ${formatAbsoluteTime(anchorSeconds)} from live_timer_start,`,
                "filling gaps between polls without leading the reported live_time.",
                "The API only carries whole seconds, so the sub-second phase is unknowable.",
            );
        } else if (!apiTimerOn) {
            lines.push("Official clock stopped — live_time used as is");
        } else {
            lines.push("No usable anchor — falling back to the reported live_time");
        }

        return lines.join("\n");
    });

    let apiTimerTitle = $derived.by(() => {
        if (!apiScores) return "Waiting for getScore";
        return [
            `live_timer_on=${apiScores.live_timer_on}`,
            `live_period=${apiScores.live_period}`,
            `live_time=${apiScores.live_time || "(empty)"}`,
            `live_timer_start=${apiScores.live_timer_start || "(empty)"}`,
            `live_timer_start_time=${apiScores.live_timer_start_time || "(empty)"}`,
        ].join("\n");
    });

    // HH:MM:SS or MM:SS to seconds
    function parseClockValue(raw) {
        if (!raw) return null;

        const parts = String(raw).split(":").map(Number);
        if (parts.some(isNaN)) return null;

        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return null;
    }

    // Parse the playing time from getScore. live_time (HH:MM:SS) is the
    // populated field in practice; live_time_mmss is often empty.
    function parseApiTime(score) {
        return parseClockValue(score.live_time || score.live_time_mmss);
    }

    // "2025-03-01 18:10:43" read as local time. Parsed by hand rather than
    // handed to Date(), whose treatment of a zone-less string varies.
    function parseTimestamp(value) {
        if (!value) return null;

        const match = String(value).match(
            /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
        );
        if (!match) return null;

        const [, year, month, day, hour, minute, second] = match.map(Number);
        return new Date(year, month - 1, day, hour, minute, second).getTime();
    }

    // Compare the server's own live_time against what the anchor implies for
    // the moment we received it. live_time is floored to whole seconds, so a
    // single sample can only under-estimate the offset - keep a short window
    // and take the maximum, which converges on the real value from below.
    function recordSkewSample(reportedSeconds, receivedAtMs, rttMs) {
        if (anchorWallMs === null || anchorSeconds === null) return;

        const computedMs = anchorSeconds * 1000 + (receivedAtMs - anchorWallMs);
        const observed = reportedSeconds * 1000 - computedMs + rttMs / 2;

        skewSamples = [...skewSamples, observed].slice(-SKEW_SAMPLE_COUNT);
        clockSkewMs = Math.round(Math.max(...skewSamples));
    }

    // Push the API time (plus drift) to the overlay as an absolute value.
    // Guarded so a drift nudge while paused does not leak to the overlay.
    function applyAutoClock() {
        if (timeMode !== "auto" || !globalTimerActive) return;

        const seconds = effectiveSeconds;
        if (seconds === null) return;

        time = formatAbsoluteTime(seconds);

        if ($connectionStatus !== "connected") return;

        // Avoid re-broadcasting an unchanged clock every second
        const key = `${seconds}|${period}|${homeTeamScore}|${awayTeamScore}`;
        if (key === lastAutoKey) return;
        lastAutoKey = key;

        sendClockWithState("clock_set", { time, seconds });
    }

    // In manual mode there is no clock event to carry an API score change,
    // so push it on its own.
    function pushScoreIfChanged() {
        if ($connectionStatus !== "connected") return;
        if (
            homeTeamScore === overlayHomeScore &&
            awayTeamScore === overlayAwayScore
        ) {
            return;
        }

        obsWebSocket.sendScoreUpdate(homeTeamScore, awayTeamScore);
        overlayHomeScore = homeTeamScore;
        overlayAwayScore = awayTeamScore;
    }

    // The anchor is refreshed once per second, but the time it implies can be
    // evaluated at any instant. Ticking locally lets the overlay change on the
    // real second boundary instead of whenever a poll happens to land.
    $effect(() => {
        if (timeMode !== "auto" || !globalTimerActive || !usingExactClock) {
            return;
        }

        const intervalId = setInterval(() => {
            nowMs = Date.now();
            applyAutoClock();
        }, 100);

        return () => clearInterval(intervalId);
    });

    // Intermission functions
    function formatPeriodLabel(value) {
        if (value === 4) return "JA";
        if (value === 5) return "RL";
        return `${value}.`;
    }

    function pushBreak() {
        if ($connectionStatus !== "connected") return;

        const key = `${breakActive}|${breakRemaining}|${breakLabel}`;
        if (key === lastBreakKey) return;
        lastBreakKey = key;

        obsWebSocket.sendBreakUpdate(breakActive, breakRemaining, breakLabel);
    }

    // The result plansi and the break panel are both full-width lower thirds,
    // so only one of them is ever on air.
    function pushPlansi() {
        if ($connectionStatus !== "connected") return;
        obsWebSocket.sendPlansiUpdate(
            resultActive,
            "result",
            RESULT_TAB_TEXT,
            null,
        );
    }

    function hideResult() {
        if (!resultActive) return;
        resultActive = false;
        pushPlansi();
    }

    function toggleResult() {
        if (resultActive) {
            hideResult();
            return;
        }

        endBreak();
        // The plansi carries no score of its own - it renders whatever the
        // overlay last got, so make sure that is the current one.
        pushScoreIfChanged();
        resultActive = true;
        pushPlansi();
    }

    function startBreak(seconds, kind) {
        hideResult();
        breakKind = kind;
        breakActive = true;
        breakEndsAtMs = Date.now() + Math.max(0, seconds) * 1000;
        gameResumedAtMs = null;
        nowMs = Date.now();
        pushBreak();
    }

    function endBreak() {
        breakActive = false;
        breakEndsAtMs = null;
        gameResumedAtMs = null;
        breakInput = "";
        breakInputActive = false;
        pushBreak();
    }

    // Each button toggles its own kind, so pressing the other one switches
    function toggleBreak(kind) {
        if (breakActive && breakKind === kind) {
            endBreak();
            return;
        }

        startBreak(
            kind === "powerbreak" ? POWER_BREAK_SECONDS : DEFAULT_BREAK_SECONDS,
            kind,
        );
    }

    // Same MMSS entry as the manual game clock
    function applyBreakInput() {
        if (!breakInput) return;

        let value = breakInput.replace(/\D/g, "").padStart(4, "0");
        const minutes = parseInt(value.substring(0, 2));
        let seconds = parseInt(value.substring(2, 4));
        if (seconds > 59) seconds = 59;

        const total = minutes * 60 + seconds;
        breakEndsAtMs = Date.now() + total * 1000;
        gameResumedAtMs = null;
        nowMs = Date.now();

        breakInput = "";
        breakInputActive = false;
        pushBreak();
    }

    // The countdown ticks locally; the overlay is only told whole seconds.
    // The panel also comes off air by itself once the official clock runs, so
    // a distracted operator cannot leave a countdown over live play.
    $effect(() => {
        if (!breakActive) return;

        const intervalId = setInterval(() => {
            nowMs = Date.now();

            if (
                gameResumedAtMs !== null &&
                nowMs - gameResumedAtMs >= BREAK_AUTOHIDE_MS
            ) {
                endBreak();
                return;
            }

            pushBreak();
        }, 100);

        return () => clearInterval(intervalId);
    });

    async function pollScore() {
        // Never let a slow response push us past one request per second
        if (isFetchingScore) return;

        isFetchingScore = true;
        try {
            await fetchCurrentScore();
        } finally {
            isFetchingScore = false;
        }
    }

    $effect(() => {
        // The official scoreboard publishes the score only when the game clock
        // resumes, so a paused clock cannot produce new data - in auto and
        // manual alike. Period mode is the exception: the play button drives no
        // clock there, so there is nothing meaningful to gate on.
        const wantsApi = timeMode === "auto" || scoreMode === "auto";
        const clockGatesPolling = timeMode !== "period";

        const shouldPoll =
            torneopalEnabled &&
            wantsApi &&
            !breakPausesPolling &&
            (!clockGatesPolling || globalTimerActive);

        if (!shouldPoll) {
            isPollingScores = false;
            pollError = "";
            return;
        }

        isPollingScores = true;
        pollScore();
        const intervalId = setInterval(pollScore, POLL_INTERVAL_MS);

        return () => {
            clearInterval(intervalId);
            isPollingScores = false;
        };
    });

    async function fetchCurrentScore() {
        if (!torneopalEnabled) {
            return;
        }

        try {
            const startedAt = Date.now();
            const result = await torneopalApi.getScore(matchId);
            const receivedAt = Date.now();

            lastRttMs = receivedAt - startedAt;
            lastPollAt = receivedAt;
            pollError = "";

            if (!result || !result.score) return;

            const score = result.score;
            apiScores = score;

            // live_period is "-1" when the match is not live
            const isLive =
                score.live_period !== undefined &&
                score.live_period !== null &&
                score.live_period !== "" &&
                score.live_period !== "-1";

            if (scoreMode === "auto") {
                const newHomeScore = parseInt(score.live_A);
                if (!isNaN(newHomeScore)) {
                    homeTeamScore = newHomeScore;
                }

                const newAwayScore = parseInt(score.live_B);
                if (!isNaN(newAwayScore)) {
                    awayTeamScore = newAwayScore;
                }
            }

            if (timeMode === "auto" && isLive) {
                const reportedPeriod = parseInt(score.live_period);
                if (!isNaN(reportedPeriod) && reportedPeriod > 0) {
                    apiPeriod = reportedPeriod;
                }

                const seconds = parseApiTime(score);
                if (seconds !== null) {
                    apiSeconds = seconds;
                }

                apiTimerOn = String(score.live_timer_on) === "1";

                // Play has resumed - the break panel has to come off air
                if (breakActive && apiTimerOn) {
                    if (gameResumedAtMs === null) gameResumedAtMs = receivedAt;
                } else {
                    gameResumedAtMs = null;
                }

                // A period that has not started yet is shown as the previous
                // one at its end time, not as the new one at 00:00
                const previousPeriod = (apiPeriod ?? 1) - 1;
                heldAtPeriodEnd =
                    apiPeriod !== null &&
                    apiPeriod > 1 &&
                    !apiTimerOn &&
                    apiSeconds === 0 &&
                    periodLengths[previousPeriod] > 0;
                if (apiPeriod !== null) {
                    period = heldAtPeriodEnd ? previousPeriod : apiPeriod;
                }

                // Anchor for the exact clock
                const anchorMs = parseTimestamp(score.live_timer_start);
                const anchorSec = parseClockValue(score.live_timer_start_time);
                if (anchorMs !== null && anchorSec !== null) {
                    anchorWallMs = anchorMs;
                    anchorSeconds = anchorSec;
                    if (apiTimerOn && seconds !== null) {
                        recordSkewSample(seconds, receivedAt, lastRttMs);
                    }
                } else {
                    anchorWallMs = null;
                    anchorSeconds = null;
                }

                apiReceivedAtMs = receivedAt;
                nowMs = receivedAt;
            }

            if (timeMode === "auto") {
                applyAutoClock();
            } else if (scoreMode === "auto" && timeMode === "manual") {
                // "period" mode has its own score effect
                pushScoreIfChanged();
            }
        } catch (error) {
            pollError = error.message || "Score poll failed";
            console.error("Failed to fetch current score:", error);
        }
    }

    // Parse time string "MM:SS" to total seconds
    function timeToSeconds(timeStr) {
        const [minutes, seconds] = timeStr.split(":").map(Number);
        return minutes * 60 + (seconds || 0);
    }

    // Penalty functions
    function getAbsoluteSeconds() {
        let total = 0;
        for (let i = 1; i < period; i++) total += periodLengths[i] || 0;
        return total + timeToSeconds(time);
    }

    function formatAbsoluteTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }

    function addPenalty(team, type) {
        const penalty = {
            id: penaltyIdCounter++,
            playerNumber: "",
            type,
            startAbsolute: getAbsoluteSeconds(),
        };
        if (team === "home") {
            homePenalties = [...homePenalties, penalty];
        } else {
            awayPenalties = [...awayPenalties, penalty];
        }
        broadcastPenalties();
    }

    function removePenalty(team, id) {
        if (team === "home") {
            homePenalties = homePenalties.filter((p) => p.id !== id);
        } else {
            awayPenalties = awayPenalties.filter((p) => p.id !== id);
        }
        broadcastPenalties();
    }

    function updatePenaltyPlayer(team, id, playerNumber) {
        if (team === "home") {
            homePenalties = homePenalties.map((p) =>
                p.id === id ? { ...p, playerNumber } : p,
            );
        } else {
            awayPenalties = awayPenalties.map((p) =>
                p.id === id ? { ...p, playerNumber } : p,
            );
        }
        broadcastPenalties();
    }

    function updatePenaltyStartTime(team, id, newAbsoluteStr) {
        let value = newAbsoluteStr.replace(/\D/g, "");
        if (value.length < 4) value = value.padStart(4, "0");
        let minutes = parseInt(value.substring(0, 2));
        let seconds = parseInt(value.substring(2, 4));
        if (seconds > 59) seconds = 59;
        const newAbsolute = minutes * 60 + seconds;

        if (team === "home") {
            homePenalties = homePenalties.map((p) =>
                p.id === id ? { ...p, startAbsolute: newAbsolute } : p,
            );
        } else {
            awayPenalties = awayPenalties.map((p) =>
                p.id === id ? { ...p, startAbsolute: newAbsolute } : p,
            );
        }
        broadcastPenalties();
    }

    function broadcastPenalties() {
        if ($connectionStatus === "connected") {
            obsWebSocket.sendPenaltyUpdate(
                $state.snapshot(homePenalties),
                $state.snapshot(awayPenalties),
            );
        }
    }

    // Shootout functions
    function addShootoutAttempt(team, result) {
        if (team === "home") {
            homeShootout = [...homeShootout, result];
        } else {
            awayShootout = [...awayShootout, result];
        }
        broadcastShootout();
    }

    function removeLastShootoutAttempt(team) {
        if (team === "home") {
            homeShootout = homeShootout.slice(0, -1);
        } else {
            awayShootout = awayShootout.slice(0, -1);
        }
        broadcastShootout();
    }

    function broadcastShootout() {
        if ($connectionStatus === "connected") {
            obsWebSocket.sendShootoutUpdate(
                $state.snapshot(homeShootout),
                $state.snapshot(awayShootout),
            );
        }
    }

    // Next period mapping
    function nextPeriod(p) {
        if (p >= 1 && p <= 2) return p + 1;
        if (p === 3) return 4; // JA
        if (p === 4) return 5; // RL
        return p;
    }

    // Global timer functions
    function startGlobalTimer() {
        globalTimerActive = true;

        if ($connectionStatus === "connected" && timeMode === "manual") {
            sendClockWithState("clock_start");
        }
    }

    function stopGlobalTimer() {
        globalTimerActive = false;

        if ($connectionStatus === "connected" && timeMode === "manual") {
            sendClockWithState("clock_pause");
            // Auto-advance happens in handleClockSync when overlay reports back
        }
    }

    function toggleGlobalTimer() {
        // Auto mode: enable/disable the API feed without leaving auto mode.
        // The polling effect depends on this flag, so re-enabling tears the
        // interval down and fires a fresh getScore right away.
        if (timeMode === "auto") {
            globalTimerActive = !globalTimerActive;
            lastAutoKey = "";
            return;
        }

        if (globalTimerActive) {
            stopGlobalTimer();
        } else {
            startGlobalTimer();
        }
    }

    function applyTimeOverride() {
        if (!overrideTime) return;

        let value = overrideTime.replace(/\D/g, "");

        if (value.length < 4) {
            value = value.padStart(4, "0");
        }

        let minutes = value.substring(0, 2);
        let seconds = value.substring(2, 4);

        const secondsNum = parseInt(seconds);
        if (secondsNum > 59) {
            seconds = "59";
        }

        const formattedTime = `${minutes}:${seconds}`;
        time = formattedTime;

        if ($connectionStatus === "connected" && timeMode === "manual") {
            obsWebSocket.sendClockControl("clock_reset", { time: formattedTime });
        }

        overrideTime = "";
        isTimeOverrideActive = false;
    }

    function copyOverlayUrl() {
        const baseUrl = `${window.location.protocol}//${window.location.host}/overlay.html`;
        const url = wsPassword
            ? `${baseUrl}?password=${encodeURIComponent(wsPassword)}`
            : baseUrl;

        navigator.clipboard
            .writeText(url)
            .then(() => {
                alert("Overlay URL copied to clipboard!");
            })
            .catch(() => {
                prompt("Copy this URL for the overlay:", url);
            });
    }

    async function updateMatchData() {
        if ($connectionStatus === "connected" && matchInfo) {
            await obsWebSocket.sendMatchInfo({
                homeTeamName,
                awayTeamName,
                homeTeamLogo: matchInfo.homeTeamLogo || "",
                awayTeamLogo: matchInfo.awayTeamLogo || "",
                timeMode,
                periodLengths,
            });
        }
    }

    async function forceRefreshMatchInfo() {
        if ($connectionStatus === "connected") {
            await obsWebSocket.sendMatchInfo({
                homeTeamName,
                awayTeamName,
                homeTeamLogo: matchInfo?.homeTeamLogo || "",
                awayTeamLogo: matchInfo?.awayTeamLogo || "",
                timeMode,
                periodLengths,
            });

            // Send period_change with score+period to flush all state to overlay
            sendClockWithState("period_change", {
                periodLength: periodLengths[period],
            });

            if (timeMode === "manual") {
                obsWebSocket.sendClockControl("clock_reset", { time });
            } else if (timeMode === "auto") {
                lastAutoKey = "";
                applyAutoClock();
            }

            broadcastPenalties();
            broadcastShootout();
        }
    }

    // Retrieve match data from localStorage by match ID
    function getStoredMatchData(id) {
        const key = `match-data-${id}`;
        const data = localStorage.getItem(key);
        if (data) {
            try {
                return JSON.parse(data);
            } catch (e) {
                console.error("Failed to parse stored match data:", e);
                return null;
            }
        }
        return null;
    }

    // Store match data in localStorage by match ID
    function storeMatchData(id, data) {
        const key = `match-data-${id}`;
        localStorage.setItem(key, JSON.stringify(data));
    }

    // Reset game - fetch match data from API and reset scores
    async function resetGame() {
        if (!matchId) {
            return;
        }
        if (!torneopalApi.isLocalMatch(matchId) && !torneopalApiKey) {
            return;
        }

        // Save match ID
        localStorage.setItem("torneopal-match-id", matchId);

        // First, check if we have cached data
        const cachedData = getStoredMatchData(matchId);
        if (cachedData) {
            matchInfo = cachedData;
            homeTeamName = cachedData.homeTeam || "Home";
            awayTeamName = cachedData.awayTeam || "Away";

            homeTeamScore = 0;
            awayTeamScore = 0;
            period = 1;
            periodLengths = cachedData.periodLengths;
            time = "00:00";

            await updateMatchData();
        }

        // Then fetch fresh data from API
        try {
            const result = await torneopalApi.getMatchEnhanced(matchId);

            if (result && result.match) {
                const match = result.match;

                if (match.period_sec) {
                    periodLengths = match.period_sec;
                }

                const newMatchInfo = {
                    homeTeam: match.team_A_name || "Home Team",
                    awayTeam: match.team_B_name || "Away Team",
                    homeTeamLogo: match.club_A_crest || "",
                    awayTeamLogo: match.club_B_crest || "",
                    date: match.date,
                    time: match.time,
                    venue: match.venue_name || "Venue",
                    category: match.category_name || "",
                    periodLengths,
                };

                storeMatchData(matchId, newMatchInfo);

                matchInfo = newMatchInfo;
                homeTeamName = newMatchInfo.homeTeam;
                awayTeamName = newMatchInfo.awayTeam;

                if (!cachedData) {
                    homeTeamScore = 0;
                    awayTeamScore = 0;
                    period = 1;
                    time = "00:00";
                }

                await updateMatchData();
            } else if (!cachedData) {
                console.error("Failed to fetch match data");
            }
        } catch (error) {
            if (!cachedData) {
                console.error("Failed to reset game:", error);
            } else {
                console.error(
                    "Failed to fetch fresh data, using cached:",
                    error,
                );
            }
        }
    }

    // Handle keyboard shortcuts
    function handleKeydown(event) {
        if (
            event.target.tagName === "INPUT" ||
            event.target.tagName === "BUTTON" ||
            event.target.tagName === "SELECT"
        ) {
            return;
        }

        if (event.code === "Space") {
            event.preventDefault();
            toggleGlobalTimer();
        }

        if (event.code !== "ArrowUp" && event.code !== "ArrowDown") {
            return;
        }

        if (timeMode === "period" || $connectionStatus !== "connected") {
            return;
        }

        const now = Date.now();
        if (now - lastKeyPress < keyDebounceDelay) {
            return;
        }

        event.preventDefault();
        lastKeyPress = now;
        const delta = event.code === "ArrowUp" ? 1 : -1;

        if (timeMode === "manual") {
            obsWebSocket.sendClockControl("clock_adjust", { delta });
        } else {
            // Auto mode: nudge the drift, never the API time itself
            adjustDrift(delta);
        }
    }

    // Handle period dropdown change
    function handlePeriodChange(event) {
        changePeriod(parseInt(event.target.value));
    }

    onMount(async () => {
        // Redirect to home if no matchId
        if (!matchId) {
            window.location.href = "index.html";
            return;
        }

        // Load score mode preference
        const savedScoreMode = localStorage.getItem("score-mode");
        if (savedScoreMode) {
            scoreMode = savedScoreMode;
        }

        // Load time mode preference
        const savedTimeMode = localStorage.getItem("time-mode");
        if (savedTimeMode) {
            timeMode = savedTimeMode;
        }

        if (timeMode === "auto") {
            // The API feed runs by default
            globalTimerActive = true;
        }

        // Load drift correction for this match
        const savedDrift = parseInt(
            localStorage.getItem(`drift-offset-${matchId}`),
        );
        if (!isNaN(savedDrift)) {
            driftOffset = savedDrift;
        }

        // Auto-connect to OBS WebSocket
        if ($connectionStatus === "disconnected") {
            await connect();
        }

        // Auto-load match data
        await resetGame();

        // Add global keydown listener
        document.addEventListener("keydown", handleKeydown);

        return () => {
            obsWebSocket.disconnect();
            stopGlobalTimer();
            document.removeEventListener("keydown", handleKeydown);
        };
    });
</script>

<div class="match-container" class:timer-active={globalTimerActive}>
    <!-- Header Bar -->
    <div class="header-bar" class:active={globalTimerActive}>
        <div class="header-content">
            {#if matchInfo}
                <div class="header-match-info">
                    {#if matchInfo.homeTeamLogo}
                        <img
                            src={matchInfo.homeTeamLogo}
                            alt={matchInfo.homeTeam}
                            class="header-team-logo"
                        />
                    {/if}
                    <span class="header-team-name">{homeTeamName}</span>
                    <span class="header-vs">vs</span>
                    <span class="header-team-name">{awayTeamName}</span>
                    {#if matchInfo.awayTeamLogo}
                        <img
                            src={matchInfo.awayTeamLogo}
                            alt={matchInfo.awayTeam}
                            class="header-team-logo"
                        />
                    {/if}
                </div>
            {:else}
                <span class="header-loading">Loading match...</span>
            {/if}

            <div class="header-actions">
                {#if isPollingScores}
                    <span
                        class="poll-status"
                        class:error={!!pollError}
                        title={pollError
                            ? `getScore failed: ${pollError}`
                            : `Polling getScore ${POLL_INTERVAL_MS / 1000}s — last ${lastPollLabel}`}
                    >
                        <span class="poll-dot"></span>
                        API
                    </span>
                {/if}
                <button
                    class="obs-status"
                    class:connected={$connectionStatus === "connected"}
                    class:error={$connectionStatus === "error"}
                    title="OBS: {$connectionStatus} — Click to refresh overlay"
                    onclick={forceRefreshMatchInfo}
                    disabled={$connectionStatus !== "connected"}
                >
                    {$connectionStatus === "connected"
                        ? "OBS"
                        : $connectionStatus === "connecting"
                          ? "..."
                          : "OBS"}
                </button>
            </div>
        </div>
    </div>

    {#if matchInfo}
        <!-- Row 1: Main controls -->
        <div class="control-row row-main" class:active={globalTimerActive}>
            <div class="control-group">
                <button
                    class="play-btn"
                    class:running={globalTimerActive}
                    onclick={toggleGlobalTimer}
                    title={timeMode === "auto"
                        ? globalTimerActive
                          ? "Pause — stop polling, freeze the overlay (Spacebar)"
                          : "Play — poll the API again (Spacebar)"
                        : globalTimerActive
                          ? "Pause (Spacebar)"
                          : "Play (Spacebar)"}
                >
                    {globalTimerActive ? "⏸" : "▶"}
                </button>

                <span class="timer-status">
                    {globalTimerActive ? "Running" : "Paused"}
                </span>

                {#if timeMode === "auto" && isPollingScores}
                    <span
                        class="api-timer"
                        class:on={apiTimerOn}
                        title={apiTimerTitle}
                    >
                        API {apiTimerOn ? "▶" : "⏸"}
                    </span>

                    <span
                        class="api-timer"
                        class:on={usingExactClock}
                        class:warn={clockSkewMs !== null && !skewTrusted}
                        title={syncTitle}
                    >
                        {syncLabel}
                    </span>

                    {#if heldAtPeriodEnd}
                        <span
                            class="api-timer hold"
                            title={`Intermission — live_period is already ${apiPeriod}, holding period ${period} at its end until the clock starts`}
                        >
                            Break
                        </span>
                    {/if}

                    {#if leadSeconds !== 0}
                        <span
                            class="api-timer warn"
                            title="On air differs from the reported live_time — a missed poll, or the Latency trim"
                        >
                            {formatAbsoluteTime(apiSeconds)} → {formatAbsoluteTime(
                                effectiveSeconds,
                            )}
                        </span>
                    {/if}
                {/if}
            </div>

            <div class="control-group">
                <span class="field-label">P</span>
                <select
                    class="period-select"
                    value={period}
                    onchange={handlePeriodChange}
                    disabled={timeMode === "auto" ||
                        $connectionStatus !== "connected"}
                >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>JA</option>
                    <option value={5}>RL</option>
                </select>

                <input
                    type="text"
                    class="time-input"
                    class:auto={timeMode === "auto"}
                    class:disabled={timeMode === "period"}
                    bind:value={overrideTime}
                    onclick={(e) => {
                        if (
                            timeMode !== "auto" &&
                            timeMode !== "period" &&
                            $connectionStatus === "connected"
                        ) {
                            e.target.select();
                        }
                    }}
                    onfocus={(e) => {
                        if (
                            timeMode !== "auto" &&
                            timeMode !== "period" &&
                            $connectionStatus === "connected"
                        ) {
                            isTimeOverrideActive = true;
                            if (!overrideTime) {
                                overrideTime = time.replace(":", "");
                            }
                            setTimeout(() => e.target.select(), 0);
                        }
                    }}
                    oninput={(e) => {
                        let value = e.target.value.replace(/\D/g, "");
                        if (value.length > 4) {
                            value = value.substring(0, 4);
                        }
                        overrideTime = value;
                    }}
                    onblur={() => {
                        overrideTime = "";
                        isTimeOverrideActive = false;
                    }}
                    onkeydown={(e) => {
                        if (e.key === "Enter") {
                            if (overrideTime) {
                                applyTimeOverride();
                            } else {
                                overrideTime = "";
                                isTimeOverrideActive = false;
                            }
                            e.target.blur();
                        }
                        if (e.key === "Escape") {
                            overrideTime = "";
                            isTimeOverrideActive = false;
                            e.target.blur();
                        }
                    }}
                    disabled={timeMode === "auto" ||
                        timeMode === "period" ||
                        $connectionStatus !== "connected"}
                    placeholder={isTimeOverrideActive ? "MMSS" : time}
                    maxlength="4"
                />
            </div>

            {#if timeMode === "auto"}
                <div class="control-group">
                    <span class="field-label">Latency</span>
                    <div class="drift-control" class:idle={!apiTimerOn}>
                        <button
                            class="drift-btn"
                            onclick={(e) => {
                                adjustDrift(-1);
                                e.currentTarget.blur();
                            }}
                            disabled={driftOffset === 0}
                            title="Latency −1 s (↓)"
                        >−</button>
                        <span
                            class="drift-value"
                            class:nonzero={driftOffset !== 0}
                            title={driftTitle}
                        >{formatDrift(driftOffset)}</span>
                        <button
                            class="drift-btn"
                            onclick={(e) => {
                                adjustDrift(1);
                                e.currentTarget.blur();
                            }}
                            disabled={driftOffset === MAX_DRIFT}
                            title="Latency +1 s (↑)"
                        >+</button>
                        <button
                            class="drift-reset"
                            onclick={(e) => {
                                resetDrift();
                                e.currentTarget.blur();
                            }}
                            disabled={driftOffset === 0}
                            title="Reset drift"
                        >⟲</button>
                    </div>
                </div>
            {/if}

            <div class="control-group">
                <div class="score-inline">
                    <NumericInput
                        bind:value={homeTeamScore}
                        disabled={scoreMode === "auto" ||
                            $connectionStatus !== "connected"}
                        autoMode={scoreMode === "auto"}
                        min={0}
                    />
                    <span class="score-dash">-</span>
                    <NumericInput
                        bind:value={awayTeamScore}
                        disabled={scoreMode === "auto" ||
                            $connectionStatus !== "connected"}
                        autoMode={scoreMode === "auto"}
                        min={0}
                    />
                    {#if scoreDirty}
                        <span class="dirty-dot" title="Score/period not yet sent to overlay"></span>
                    {/if}
                </div>
            </div>
        </div>

        <!-- Row 2: Mode selectors -->
        <div class="control-row row-modes">
            <div class="mode-group">
                <span class="mode-label">Score</span>
                <label class="radio-option">
                    <input
                        type="radio"
                        bind:group={scoreMode}
                        value="auto"
                        onchange={() => setScoreMode("auto")}
                    />
                    <span class="radio-text">auto</span>
                </label>
                <label class="radio-option">
                    <input
                        type="radio"
                        bind:group={scoreMode}
                        value="manual"
                        onchange={() => setScoreMode("manual")}
                    />
                    <span class="radio-text">manual</span>
                </label>
            </div>

            <div class="mode-group">
                <span class="mode-label">Time</span>
                <label class="radio-option">
                    <input
                        type="radio"
                        bind:group={timeMode}
                        value="auto"
                        onchange={() => setTimeMode("auto")}
                    />
                    <span class="radio-text">auto</span>
                </label>
                <label class="radio-option">
                    <input
                        type="radio"
                        bind:group={timeMode}
                        value="manual"
                        onchange={() => setTimeMode("manual")}
                    />
                    <span class="radio-text">manual</span>
                </label>
                <label class="radio-option">
                    <input
                        type="radio"
                        bind:group={timeMode}
                        value="period"
                        onchange={() => setTimeMode("period")}
                    />
                    <span class="radio-text">period</span>
                </label>
            </div>
        </div>

        <!-- Row 3: Penalties -->
        <div class="control-row row-penalties">
            <div class="penalty-column">
                <div class="penalty-header">
                    <span class="penalty-team-label">Home</span>
                    <div class="penalty-add">
                        <button
                            class="penalty-btn penalty-2min"
                            onclick={() => addPenalty("home", "2min")}
                            disabled={$connectionStatus !== "connected"}
                        >+2</button>
                        <button
                            class="penalty-btn penalty-2plus2"
                            onclick={() => addPenalty("home", "2+2")}
                            disabled={$connectionStatus !== "connected"}
                        >+2+2</button>
                    </div>
                </div>
                {#each homePenalties as penalty (penalty.id)}
                    <div class="penalty-item">
                        <input
                            type="text"
                            class="penalty-player-input"
                            value={penalty.playerNumber}
                            placeholder="#"
                            maxlength="3"
                            onfocus={(e) => setTimeout(() => e.target.select(), 0)}
                            onblur={(e) => {
                                if (e.target.value !== penalty.playerNumber) {
                                    updatePenaltyPlayer("home", penalty.id, e.target.value);
                                }
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter") {
                                    updatePenaltyPlayer("home", penalty.id, e.target.value);
                                    e.target.blur();
                                }
                                if (e.key === "Escape") e.target.blur();
                            }}
                        />
                        <input
                            type="text"
                            class="penalty-time-edit"
                            value={formatAbsoluteTime(penalty.startAbsolute)}
                            maxlength="5"
                            onfocus={(e) => {
                                e.target.value = formatAbsoluteTime(penalty.startAbsolute).replace(":", "");
                                setTimeout(() => e.target.select(), 0);
                            }}
                            onblur={(e) => {
                                if (e.target.value !== formatAbsoluteTime(penalty.startAbsolute).replace(":", "")) {
                                    updatePenaltyStartTime("home", penalty.id, e.target.value);
                                }
                                e.target.value = formatAbsoluteTime(penalty.startAbsolute);
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter") {
                                    updatePenaltyStartTime("home", penalty.id, e.target.value);
                                    e.target.blur();
                                }
                                if (e.key === "Escape") e.target.blur();
                            }}
                        />
                        <span class="penalty-type">{penalty.type}</span>
                        <button
                            class="penalty-remove"
                            onclick={() => removePenalty("home", penalty.id)}
                        >X</button>
                    </div>
                {/each}
            </div>

            <div class="penalty-divider"></div>

            <div class="penalty-column">
                <div class="penalty-header">
                    <span class="penalty-team-label">Away</span>
                    <div class="penalty-add">
                        <button
                            class="penalty-btn penalty-2min"
                            onclick={() => addPenalty("away", "2min")}
                            disabled={$connectionStatus !== "connected"}
                        >+2</button>
                        <button
                            class="penalty-btn penalty-2plus2"
                            onclick={() => addPenalty("away", "2+2")}
                            disabled={$connectionStatus !== "connected"}
                        >+2+2</button>
                    </div>
                </div>
                {#each awayPenalties as penalty (penalty.id)}
                    <div class="penalty-item">
                        <input
                            type="text"
                            class="penalty-player-input"
                            value={penalty.playerNumber}
                            placeholder="#"
                            maxlength="3"
                            onfocus={(e) => setTimeout(() => e.target.select(), 0)}
                            onblur={(e) => {
                                if (e.target.value !== penalty.playerNumber) {
                                    updatePenaltyPlayer("away", penalty.id, e.target.value);
                                }
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter") {
                                    updatePenaltyPlayer("away", penalty.id, e.target.value);
                                    e.target.blur();
                                }
                                if (e.key === "Escape") e.target.blur();
                            }}
                        />
                        <input
                            type="text"
                            class="penalty-time-edit"
                            value={formatAbsoluteTime(penalty.startAbsolute)}
                            maxlength="5"
                            onfocus={(e) => {
                                e.target.value = formatAbsoluteTime(penalty.startAbsolute).replace(":", "");
                                setTimeout(() => e.target.select(), 0);
                            }}
                            onblur={(e) => {
                                if (e.target.value !== formatAbsoluteTime(penalty.startAbsolute).replace(":", "")) {
                                    updatePenaltyStartTime("away", penalty.id, e.target.value);
                                }
                                e.target.value = formatAbsoluteTime(penalty.startAbsolute);
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter") {
                                    updatePenaltyStartTime("away", penalty.id, e.target.value);
                                    e.target.blur();
                                }
                                if (e.key === "Escape") e.target.blur();
                            }}
                        />
                        <span class="penalty-type">{penalty.type}</span>
                        <button
                            class="penalty-remove"
                            onclick={() => removePenalty("away", penalty.id)}
                        >X</button>
                    </div>
                {/each}
            </div>
        </div>

        <!-- Row 4: Intermission panel -->
        <div
            class="control-row row-break"
            class:active={breakActive || resultActive}
        >
            <div class="control-group">
                <button
                    class="break-btn"
                    class:on={breakActive && breakKind === "intermission"}
                    class:suggested={!breakActive && heldAtPeriodEnd}
                    onclick={() => toggleBreak("intermission")}
                    disabled={$connectionStatus !== "connected"}
                    title={breakActive && breakKind === "intermission"
                        ? "Take the panel off air"
                        : `Put "${formatPeriodLabel(period)} ERÄTAUKO" on air`}
                >
                    Intermission
                </button>

                <button
                    class="break-btn"
                    class:on={breakActive && breakKind === "powerbreak"}
                    onclick={() => toggleBreak("powerbreak")}
                    disabled={$connectionStatus !== "connected"}
                    title={breakActive && breakKind === "powerbreak"
                        ? "Take the panel off air"
                        : `Put "${formatPeriodLabel(period)} POWER BREAK" on air (${POWER_BREAK_SECONDS}s)`}
                >
                    Power break
                </button>

                <button
                    class="break-btn"
                    class:on={resultActive}
                    onclick={toggleResult}
                    disabled={$connectionStatus !== "connected"}
                    title={resultActive
                        ? "Take the result plansi off air"
                        : `Put the result plansi on air (${homeTeamScore}-${awayTeamScore})`}
                >
                    Result
                </button>

                <input
                    type="text"
                    class="time-input"
                    bind:value={breakInput}
                    onfocus={(e) => {
                        breakInputActive = true;
                        if (!breakInput) {
                            breakInput = formatAbsoluteTime(
                                breakActive ? breakRemaining : DEFAULT_BREAK_SECONDS,
                            ).replace(":", "");
                        }
                        // currentTarget is nulled once the handler returns, so
                        // the deferred select needs its own reference
                        const field = e.currentTarget;
                        setTimeout(() => field.select(), 0);
                    }}
                    onclick={(e) => e.currentTarget.select()}
                    oninput={(e) => {
                        breakInput = e.currentTarget.value
                            .replace(/\D/g, "")
                            .substring(0, 4);
                    }}
                    onblur={() => {
                        breakInput = "";
                        breakInputActive = false;
                    }}
                    onkeydown={(e) => {
                        if (e.key === "Enter") {
                            applyBreakInput();
                            e.currentTarget.blur();
                        }
                        if (e.key === "Escape") {
                            breakInput = "";
                            breakInputActive = false;
                            e.currentTarget.blur();
                        }
                    }}
                    disabled={$connectionStatus !== "connected"}
                    placeholder={breakInputActive
                        ? "MMSS"
                        : formatAbsoluteTime(
                              breakActive ? breakRemaining : DEFAULT_BREAK_SECONDS,
                          )}
                    maxlength="4"
                />

                {#if breakActive}
                    <span class="break-status" class:ending={breakRemaining === 0}>
                        {breakRemaining === 0
                            ? "Break over"
                            : formatAbsoluteTime(breakRemaining)}
                    </span>

                    <span class="break-label-preview">{breakLabel}</span>

                    {#if gameResumedAtMs !== null}
                        <span class="break-resumed">
                            Game running — panel closing
                        </span>
                    {:else if breakPausesPolling}
                        <span class="break-note">
                            Polling paused until {BREAK_POLL_RESUME_SEC}s left
                        </span>
                    {/if}
                {:else if heldAtPeriodEnd}
                    <span class="break-note">Intermission detected</span>
                {/if}

                {#if resultActive}
                    <span class="break-label-preview">
                        {RESULT_TAB_TEXT}
                        {homeTeamScore}-{awayTeamScore}
                    </span>
                {/if}
            </div>
        </div>

        <!-- Row 5: Shootout (only in period 5 / RL) -->
        {#if period === 5}
            <div class="control-row row-shootout">
                <div class="shootout-column">
                    <span class="shootout-team-label">Home</span>
                    <div class="shootout-dots-row">
                        {#each homeShootout as attempt}
                            <span class="shootout-dot-admin" class:goal={attempt} class:miss={!attempt}></span>
                        {/each}
                    </div>
                    <div class="shootout-actions">
                        <button
                            class="shootout-btn shootout-goal"
                            onclick={() => addShootoutAttempt("home", true)}
                            disabled={$connectionStatus !== "connected"}
                        >Goal</button>
                        <button
                            class="shootout-btn shootout-miss"
                            onclick={() => addShootoutAttempt("home", false)}
                            disabled={$connectionStatus !== "connected"}
                        >Miss</button>
                        {#if homeShootout.length > 0}
                            <button
                                class="shootout-btn shootout-undo"
                                onclick={() => removeLastShootoutAttempt("home")}
                            >Undo</button>
                        {/if}
                    </div>
                </div>

                <div class="shootout-divider"></div>

                <div class="shootout-column">
                    <span class="shootout-team-label">Away</span>
                    <div class="shootout-dots-row">
                        {#each awayShootout as attempt}
                            <span class="shootout-dot-admin" class:goal={attempt} class:miss={!attempt}></span>
                        {/each}
                    </div>
                    <div class="shootout-actions">
                        <button
                            class="shootout-btn shootout-goal"
                            onclick={() => addShootoutAttempt("away", true)}
                            disabled={$connectionStatus !== "connected"}
                        >Goal</button>
                        <button
                            class="shootout-btn shootout-miss"
                            onclick={() => addShootoutAttempt("away", false)}
                            disabled={$connectionStatus !== "connected"}
                        >Miss</button>
                        {#if awayShootout.length > 0}
                            <button
                                class="shootout-btn shootout-undo"
                                onclick={() => removeLastShootoutAttempt("away")}
                            >Undo</button>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}
    {/if}
</div>

<style>
    :global(body) {
        background: #121212;
        color: #ffffff;
        margin: 0;
        transition: background-color 0.3s ease;
    }

    :global(body:has(.match-container.timer-active)) {
        background:
            linear-gradient(rgba(76, 175, 80, 0.05), rgba(76, 175, 80, 0.05)),
            #121212;
    }

    .match-container {
        max-width: 1200px;
        margin: 0;
        padding: 70px 20px 20px 20px;
        font-family: Arial, sans-serif;
        min-height: 100vh;
        position: relative;
    }

    /* Header Bar */
    .header-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #1a1a1a;
        border-bottom: 2px solid #333;
        padding: 10px 20px;
        z-index: 1001;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        transition: all 0.3s ease;
    }

    .header-bar.active {
        border-bottom-color: #4caf50;
        background: linear-gradient(
            180deg,
            rgba(76, 175, 80, 0.08) 0%,
            #1a1a1a 100%
        );
    }

    .header-content {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 40px;
        padding: 0 20px;
    }

    .header-match-info {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 16px;
    }

    .header-team-logo {
        width: 32px;
        height: 32px;
        object-fit: contain;
        background: white;
        border-radius: 4px;
        padding: 2px;
    }

    .header-team-name {
        font-weight: bold;
        color: #fff;
    }

    .header-vs {
        color: #666;
        font-size: 14px;
    }

    .header-loading {
        color: #888;
        font-size: 14px;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .obs-status {
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: bold;
        background: #333;
        color: #888;
        border: 1px solid transparent;
        cursor: pointer;
    }

    .obs-status:hover:not(:disabled) {
        background: #444;
        color: #ccc;
    }

    .obs-status.connected {
        background: rgba(76, 175, 80, 0.15);
        color: #4caf50;
        border-color: #4caf50;
    }

    .obs-status.connected:hover {
        background: rgba(76, 175, 80, 0.25);
    }

    .obs-status.error {
        background: rgba(244, 67, 54, 0.15);
        color: #f44336;
        border-color: #f44336;
    }

    .obs-status:disabled {
        cursor: default;
        opacity: 0.6;
    }

    /* Score poll indicator */
    .poll-status {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: bold;
        letter-spacing: 0.5px;
        background: rgba(33, 150, 243, 0.15);
        border: 1px solid #2196f3;
        color: #2196f3;
        cursor: help;
    }

    .poll-status.error {
        background: rgba(244, 67, 54, 0.15);
        border-color: #f44336;
        color: #f44336;
    }

    .poll-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        animation: poll-pulse 1s ease-in-out infinite;
    }

    .poll-status.error .poll-dot {
        animation: none;
    }

    @keyframes poll-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.2;
        }
    }

    /* Control Rows */
    .control-row {
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 12px 16px;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        transition: all 0.3s ease;
    }

    .control-group {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .row-main.active {
        border-color: #4caf50;
        background: linear-gradient(
            135deg,
            #1e1e1e 0%,
            rgba(76, 175, 80, 0.1) 100%
        );
    }

    /* Play/Pause Button */
    .play-btn {
        width: 40px;
        height: 36px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        padding: 0;
        flex-shrink: 0;
    }

    .play-btn:hover {
        background: #333;
        border-color: #666;
    }

    .play-btn.running {
        background: #4caf50;
        border-color: #4caf50;
        color: #fff;
    }

    .play-btn.running:hover {
        background: #66bb6a;
        border-color: #66bb6a;
    }

    .timer-status {
        font-size: 13px;
        color: #888;
        font-weight: bold;
        min-width: 55px;
    }

    .row-main.active .timer-status {
        color: #4caf50;
    }

    /* Intermission panel row */
    .row-break.active {
        border-color: #7e57c2;
        background: linear-gradient(
            135deg,
            #1e1e1e 0%,
            rgba(126, 87, 194, 0.12) 100%
        );
    }

    .break-btn {
        height: 36px;
        padding: 0 14px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #ccc;
        font-size: 13px;
        font-weight: bold;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.2s;
    }

    .break-btn:hover:not(:disabled) {
        background: #333;
        border-color: #666;
        color: #fff;
    }

    .break-btn.on {
        background: #542c8c;
        border-color: #7e57c2;
        color: #fff;
    }

    .break-btn.suggested {
        border-color: #ffc107;
        color: #ffc107;
    }

    .break-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .break-status {
        font-size: 15px;
        font-weight: bold;
        color: #b39ddb;
        font-variant-numeric: tabular-nums;
        min-width: 55px;
    }

    .break-status.ending {
        color: #ffc107;
    }

    .break-note {
        font-size: 11px;
        color: #777;
    }

    .break-label-preview {
        font-size: 11px;
        font-weight: bold;
        letter-spacing: 0.5px;
        color: #b39ddb;
        padding: 3px 7px;
        border-radius: 4px;
        background: rgba(84, 44, 140, 0.35);
        white-space: nowrap;
    }

    .break-resumed {
        font-size: 11px;
        font-weight: bold;
        color: #f44336;
    }

    /* Official scoreboard clock state (auto mode only) */
    .api-timer {
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: bold;
        letter-spacing: 0.5px;
        white-space: nowrap;
        background: #2a2a2a;
        border: 1px solid #444;
        color: #777;
        cursor: help;
    }

    .api-timer.on {
        background: rgba(76, 175, 80, 0.15);
        border-color: #4caf50;
        color: #4caf50;
    }

    .api-timer.warn {
        background: rgba(244, 67, 54, 0.15);
        border-color: #f44336;
        color: #f44336;
    }

    .api-timer.hold {
        background: rgba(255, 193, 7, 0.15);
        border-color: #ffc107;
        color: #ffc107;
    }

    .control-group + .control-group {
        padding-left: 12px;
        border-left: 1px solid #333;
    }

    .field-label {
        font-size: 13px;
        color: #888;
        font-weight: bold;
    }

    /* Period Select */
    .period-select {
        height: 36px;
        width: 55px;
        background: #2a2a2a;
        color: #fff;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 14px;
        font-weight: bold;
        text-align: center;
        cursor: pointer;
        padding: 0 4px;
    }

    .period-select:disabled {
        background: #1a1a1a;
        border-color: #333;
        color: #666;
        cursor: not-allowed;
    }

    .period-select:focus {
        outline: none;
        border-color: #2196f3;
    }

    /* Time Input */
    .time-input {
        width: 70px;
        height: 36px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #2a2a2a;
        color: #fff;
        font-size: 15px;
        font-weight: bold;
        text-align: center;
        padding: 0 6px;
        box-sizing: border-box;
        transition: all 0.2s;
    }

    .time-input:focus {
        outline: none;
        border-color: #2196f3;
        background: #333;
    }

    .time-input:disabled {
        background: #1a1a1a;
        border-color: #333;
        color: #666;
        cursor: not-allowed;
    }

    .time-input.auto {
        background: rgba(33, 150, 243, 0.1);
        border-color: #2196f3;
        color: #2196f3;
    }

    .time-input.disabled {
        background: #1a1a1a;
        border-color: #333;
        color: #666;
        cursor: not-allowed;
    }

    /* Drift correction (auto mode only) */
    .drift-control {
        display: flex;
        align-items: center;
        gap: 2px;
        height: 36px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        padding: 0 3px;
        box-sizing: border-box;
    }

    .drift-btn,
    .drift-reset {
        width: 24px;
        height: 28px;
        background: transparent;
        border: none;
        border-radius: 3px;
        color: #ccc;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        padding: 0;
        line-height: 1;
    }

    .drift-btn:hover:not(:disabled),
    .drift-reset:hover:not(:disabled) {
        background: #3a3a3a;
        color: #fff;
    }

    .drift-btn:disabled {
        opacity: 0.3;
        cursor: default;
    }

    /* The correction only applies while the official clock is running */
    .drift-control.idle {
        opacity: 0.5;
    }

    .drift-reset {
        font-size: 12px;
        color: #777;
    }

    .drift-reset:disabled {
        opacity: 0.3;
        cursor: default;
    }

    .drift-value {
        min-width: 34px;
        text-align: center;
        font-size: 13px;
        font-weight: bold;
        color: #666;
        cursor: help;
    }

    .drift-value.nonzero {
        color: #ffc107;
    }

    /* Inline Score */
    .score-inline {
        display: flex;
        align-items: center;
        gap: 6px;
        position: relative;
    }

    .score-dash {
        font-size: 18px;
        color: #666;
        font-weight: bold;
    }

    .dirty-dot {
        width: 8px;
        height: 8px;
        background: #ff9800;
        border-radius: 50%;
        flex-shrink: 0;
        animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.4;
        }
    }

    /* Row 2: Mode Selectors */
    .row-modes {
        padding: 8px 16px;
        gap: 12px 16px;
    }

    .mode-group {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .mode-group + .mode-group {
        padding-left: 16px;
        border-left: 1px solid #333;
    }

    .mode-label {
        font-size: 12px;
        font-weight: bold;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .radio-option {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        color: #aaa;
        font-size: 13px;
    }

    .radio-option input[type="radio"] {
        width: 14px;
        height: 14px;
        cursor: pointer;
    }

    .radio-option:hover {
        color: #fff;
    }

    .radio-text {
        font-size: 13px;
    }

    /* Global button styles */
    button {
        padding: 8px 16px;
        background: #2196f3;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
    }

    button:hover {
        background: #42a5f5;
    }

    button:disabled {
        background: #555;
        cursor: not-allowed;
        opacity: 0.6;
    }

    label {
        color: #ffffff;
    }

    /* Row 3: Penalties */
    .row-penalties {
        display: flex;
        gap: 0;
        padding: 12px 16px;
    }

    .penalty-column {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .penalty-divider {
        width: 1px;
        background: #333;
        margin: 0 12px;
        align-self: stretch;
    }

    .penalty-header {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .penalty-team-label {
        font-size: 12px;
        font-weight: bold;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        min-width: 40px;
    }

    .penalty-add {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .penalty-player-input {
        width: 36px;
        height: 28px;
        background: #2a2a2a;
        color: #fff;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 13px;
        font-weight: bold;
        text-align: center;
        padding: 0 4px;
        box-sizing: border-box;
    }

    .penalty-player-input:focus {
        outline: none;
        border-color: #2196f3;
        background: #333;
    }

    .penalty-btn {
        height: 28px;
        padding: 0 8px;
        font-size: 12px;
        font-weight: bold;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: background 0.2s;
    }

    .penalty-2min {
        background: #c62828;
        color: white;
    }

    .penalty-2min:hover:not(:disabled) {
        background: #e53935;
    }

    .penalty-2plus2 {
        background: #8b0000;
        color: white;
    }

    .penalty-2plus2:hover:not(:disabled) {
        background: #b71c1c;
    }

    .penalty-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: #2a2a2a;
        border-radius: 4px;
        font-size: 13px;
    }


    .penalty-time-edit {
        width: 50px;
        height: 24px;
        background: #1e1e1e;
        color: #aaa;
        border: 1px solid #333;
        border-radius: 3px;
        font-size: 12px;
        font-family: monospace;
        text-align: center;
        padding: 0 4px;
        box-sizing: border-box;
    }

    .penalty-time-edit:focus {
        outline: none;
        border-color: #2196f3;
        background: #333;
        color: #fff;
    }

    .penalty-type {
        color: #888;
        font-size: 12px;
        min-width: 30px;
    }

    .penalty-remove {
        width: 24px;
        height: 24px;
        padding: 0;
        background: #444;
        color: #aaa;
        border: none;
        border-radius: 3px;
        font-size: 11px;
        font-weight: bold;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-left: auto;
    }

    .penalty-remove:hover {
        background: #c62828;
        color: white;
    }

    /* Row 4: Shootout */
    .row-shootout {
        display: flex;
        gap: 0;
        padding: 12px 16px;
    }

    .shootout-column {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .shootout-divider {
        width: 1px;
        background: #333;
        margin: 0 12px;
        align-self: stretch;
    }

    .shootout-team-label {
        font-size: 12px;
        font-weight: bold;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .shootout-dots-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 16px;
    }

    .shootout-dot-admin {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        display: inline-block;
    }

    .shootout-dot-admin.goal {
        background: #4caf50;
        box-shadow: 0 0 4px rgba(76, 175, 80, 0.5);
    }

    .shootout-dot-admin.miss {
        background: #f44336;
        box-shadow: 0 0 4px rgba(244, 67, 54, 0.5);
    }

    .shootout-actions {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .shootout-btn {
        height: 28px;
        padding: 0 8px;
        font-size: 12px;
        font-weight: bold;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: background 0.2s;
    }

    .shootout-goal {
        background: #2e7d32;
        color: white;
    }

    .shootout-goal:hover:not(:disabled) {
        background: #388e3c;
    }

    .shootout-miss {
        background: #c62828;
        color: white;
    }

    .shootout-miss:hover:not(:disabled) {
        background: #e53935;
    }

    .shootout-undo {
        background: #444;
        color: #aaa;
    }

    .shootout-undo:hover {
        background: #555;
        color: #fff;
    }
</style>
