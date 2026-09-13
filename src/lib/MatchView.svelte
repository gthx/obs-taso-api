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
    // duration. The instant it comes back is computed from the countdown when
    // the break starts, so nothing here has to tick for it to resume.
    const BREAK_POLL_RESUME_SEC = 5;

    // How long the official clock has to run before the panel comes off air
    const BREAK_AUTOHIDE_MS = 2000;
    // How often the break state is repeated for the benefit of an overlay that
    // reloaded mid-break. Not what drives the countdown.
    const BREAK_RESYNC_MS = 10000;
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

    // Manual trim on top of the computed clock (seconds). Auto mode only -
    // the manual clock is never affected by this. The operator is in the hall
    // with the official board in sight and the broadcast on the hall screen
    // next to it, and lines the two up by eye: positive runs the clock on air
    // ahead, which is what covers the video delay between OBS and that screen;
    // negative holds it back for everything that puts us in front of the board.
    const MAX_DRIFT = 10;
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

    // How long ago the reading we are bounded by arrived
    let sampleAge = $derived(
        apiReceivedAtMs === null
            ? 0
            : Math.max(0, nowMs - apiReceivedAtMs) / 1000,
    );

    // Phase source when there is no trusted server anchor: the first reading
    // of this running stretch, free-run from there. Without it the fraction
    // would come from whichever poll last landed, and since polls drift
    // against the official second boundary it would move by up to a second
    // between them - which the overlay would faithfully re-anchor to.
    let freeAnchorWallMs = $state(/** @type {number | null} */ (null));
    let freeAnchorSeconds = $state(/** @type {number | null} */ (null));

    function clampToPeriod(seconds) {
        const periodLength = periodLengths[period] || 0;
        const floored = Math.max(0, seconds);
        return periodLength > 0 ? Math.min(floored, periodLength) : floored;
    }

    // Playing time as a continuous value, from whichever anchor we have. The
    // phase belongs to the anchor and holds for the whole running stretch, so
    // the second turns over at the same point in every wall-clock second.
    let smoothSeconds = $derived.by(() => {
        if (usingExactClock) {
            return anchorSeconds + (nowMs + clockSkewMs - anchorWallMs) / 1000;
        }
        if (freeAnchorWallMs !== null && freeAnchorSeconds !== null) {
            return freeAnchorSeconds + (nowMs - freeAnchorWallMs) / 1000;
        }
        return null;
    });

    // The playing time at this instant, fraction included. This is the value
    // handed to the overlay: the overlay runs the clock on air from it, so it
    // needs the sub-second phase to turn the second over where the official
    // clock turns it over rather than whenever a message happens to arrive.
    // A stopped clock reports an exact value that is not going stale, so there
    // is nothing to correct while it is off.
    let effectiveSecondsExact = $derived.by(() => {
        if (heldAtPeriodEnd) return periodLengths[period] || 0;
        if (!apiTimerOn) return apiSeconds;

        if (smoothSeconds === null) {
            // Nothing to run from yet: the reported time as it stands
            if (apiSeconds === null) return null;
            return clampToPeriod(apiSeconds + driftOffset);
        }

        if (apiSeconds === null) return clampToPeriod(smoothSeconds);

        // live_time is floored by the server, so a reading of N taken `age`
        // seconds ago puts the official clock somewhere in [N + age, N + 1 +
        // age) now: a one-second band sliding at real time. Inside it the
        // free-running value is left exactly as it is - that is where the
        // phase on air comes from - and it is only pulled back when it leaves
        // the band, which takes a real disagreement (the official clock
        // rewound, a period reset) rather than a fraction of a second.
        // Pinning it to N instead would put the second boundary wherever the
        // poll happened to land, which is the one thing the anchor exists to
        // avoid.
        const earliest = apiSeconds + sampleAge;
        const bounded = Math.min(
            Math.max(smoothSeconds, earliest),
            earliest + 1,
        );

        // The operator's own trim sits outside the band on purpose: it is
        // lining the clock on air up against the board in the hall, which is
        // a different question from what the API last reported.
        return clampToPeriod(bounded + driftOffset);
    });

    let effectiveSeconds = $derived(
        effectiveSecondsExact === null
            ? null
            : Math.floor(effectiveSecondsExact),
    );

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
    // as the manual game clock. The overlay owns the clock on air: it is told
    // the remaining time when it changes and counts down itself, so a
    // throttled admin tab cannot freeze what the viewer sees.
    let breakActive = $state(false);
    let breakEndsAtMs = $state(/** @type {number | null} */ (null));
    let breakInput = $state("");
    let breakKind = $state("intermission"); // "intermission" or "powerbreak"
    let breakInputActive = $state(false);
    let gameResumedAtMs = $state(/** @type {number | null} */ (null));

    // Result plansi. The PSD's tab layer reads "LOPPUTULOS" - the "RESULT" in
    // the Havainnekuva render is that render's own wording, and the rest of
    // the overlay is Finnish. A plain string if it ever has to say otherwise.
    const RESULT_TAB_TEXT = "LOPPUTULOS";
    let resultActive = $state(false);

    // The instant the break ends, not a ticking countdown: this view shows
    // when it is over, the overlay shows how long is left.
    let breakEndsAtLabel = $derived(
        breakEndsAtMs === null
            ? ""
            : new Date(breakEndsAtMs).toLocaleTimeString(),
    );

    // Remaining whole seconds right now. Read when something is sent or typed,
    // never rendered - nothing in this view counts down.
    function breakRemainingNow() {
        if (breakEndsAtMs === null) return 0;
        return Math.max(0, Math.ceil((breakEndsAtMs - Date.now()) / 1000));
    }

    // Polling is paused until this wall-clock instant. Compared against the
    // clock rather than counted down, so a tab that was throttled through the
    // break resumes on its first tick afterwards instead of drifting.
    let pollPausedUntilMs = $state(/** @type {number | null} */ (null));

    // The interval now keeps running through a break, so "polling" on the
    // header means requests are actually going out
    let pollingLive = $derived(isPollingScores && pollPausedUntilMs === null);

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

    // Just the wordmark: the panel's tab carries the period it belongs to, so
    // prefixing it here would say it twice.
    let breakLabel = $derived(
        breakKind === "powerbreak" ? "POWER BREAK" : "ERÄTAUKO",
    );

    // Track what the overlay currently has (last sent via ClockControl)
    let overlayHomeScore = $state(0);
    let overlayAwayScore = $state(0);
    let overlayPeriod = $state(1);

    // ...and the clock anchor it was last given, so the same arithmetic it
    // runs can be repeated here to see whether it still agrees with us.
    let overlayClockRunning = false;
    let overlayClockSeconds = /** @type {number | null} */ (null);
    let overlayClockSentAtMs = 0;

    // How often the anchor is repeated even when nothing changed. This is the
    // only thing an overlay that reloaded mid-match has to wait for, and the
    // only clock traffic during a long stoppage.
    const CLOCK_RESYNC_MS = 5000;
    // How far the overlay may be from our own reading before it is re-anchored.
    // Matches the tolerance the overlay applies to an incoming anchor, so a
    // resync that agrees with it does not nudge what is on air.
    const CLOCK_RESYNC_TOLERANCE = 0.25;
    // A running clock is never walked backwards by less than this. The skew
    // estimate is a maximum over a sliding window of samples, so it wobbles by
    // a fraction of a second as samples age out - enough, once the phase is
    // live, to step the clock on air back over a second boundary. A real
    // correction is a whole second or more and still gets through.
    const MAX_SILENT_REWIND = 1;

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

        // A period change resets the overlay's clock to 00:00 and stops it.
        // Mirror that here, or the next push would compare against an anchor
        // the overlay has already thrown away.
        if (action === "period_change") {
            overlayClockRunning = false;
            overlayClockSeconds = 0;
            overlayClockSentAtMs = Date.now();
        }
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

    // An overlay that has just loaded asks for the state it missed. Answering
    // over the socket works even with this tab in the background, which is
    // exactly when the overlay would otherwise be waiting on a throttled
    // timer for the next resync.
    let lastClockRequestAt = 0;
    function handleClockRequest() {
        const now = Date.now();
        if (now - lastClockRequestAt < 2000) return; // several sources, one answer
        lastClockRequestAt = now;
        invalidateOverlayClock();
        forceRefreshMatchInfo();
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
                    if (eventName !== "ClockControl") return;

                    if (eventData.action === "clock_sync") {
                        handleClockSync(eventData);
                    } else if (eventData.action === "clock_request") {
                        handleClockRequest();
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
            // The overlay is running its own clock from the last anchor, so
            // leaving auto has to stop it explicitly.
            pauseOverlayClock();
        }
        invalidateOverlayClock();

        updateMatchData();
    }

    // Drift functions - auto mode only
    function setDrift(value) {
        driftOffset = value;
        if (matchId) {
            localStorage.setItem(`drift-offset-${matchId}`, String(value));
        }
        // Forced: a trim the operator just made is deliberate, so it goes out
        // whole even when it walks the clock backwards - the guard against
        // small rewinds is there for the estimator's wobble, not for this.
        applyAutoClock(true);
    }

    function adjustDrift(delta) {
        setDrift(
            Math.min(MAX_DRIFT, Math.max(-MAX_DRIFT, driftOffset + delta)),
        );
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
            return `Clock stopped — API ${formatAbsoluteTime(apiSeconds)} used as is, nothing to trim`;
        }
        const source = usingExactClock ? "Computed" : "Reported live_time";
        return `${source} ${formatDrift(driftOffset)} → overlay ${formatAbsoluteTime(effectiveSeconds)}`;
    });

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

    // The clock on air belongs to the overlay. What goes over the wire is a
    // state transition plus the anchor it starts from, not a value per second:
    // this tab's timers stop being reliable the moment it is behind the OBS
    // window, and a clock driven from here would stall on air.
    function pushClockState(running, seconds, force = false) {
        if ($connectionStatus !== "connected") return;

        const now = Date.now();

        // What the overlay is showing right now, from the anchor it was last
        // given - the same arithmetic it does itself.
        const shown =
            overlayClockSeconds === null
                ? null
                : overlayClockSeconds +
                  (overlayClockRunning
                      ? (now - overlayClockSentAtMs) / 1000
                      : 0);

        const gap = shown === null ? null : seconds - shown;
        const rewinding =
            running && gap !== null && gap < 0 && -gap < MAX_SILENT_REWIND;

        const stateChanged =
            running !== overlayClockRunning || period !== overlayPeriod;
        const stale = now - overlayClockSentAtMs >= CLOCK_RESYNC_MS;
        const diverged =
            gap === null || (Math.abs(gap) > CLOCK_RESYNC_TOLERANCE && !rewinding);

        if (!force && !stateChanged && !stale && !diverged) return;

        // A resync that would rewind repeats what the overlay already has: it
        // still answers a reloaded overlay without touching a running one.
        const anchor = rewinding ? shown : seconds;

        overlayClockRunning = running;
        overlayClockSeconds = anchor;
        overlayClockSentAtMs = now;

        sendClockWithState(running ? "clock_run" : "clock_pause", {
            seconds: anchor,
            time: formatAbsoluteTime(Math.floor(anchor)),
        });
    }

    // Forget what the overlay is believed to have, so the next push goes out
    // whatever it says. Used when the overlay may have missed something.
    function invalidateOverlayClock() {
        overlayClockSeconds = null;
        overlayClockSentAtMs = 0;
    }

    // Stop the overlay clock at the time we last worked out, whether or not
    // the auto feed is still running - a paused feed must not leave a clock
    // free-running on air.
    function pauseOverlayClock() {
        const seconds = effectiveSecondsExact;
        pushClockState(
            false,
            seconds === null ? timeToSeconds(time) : Math.floor(seconds),
            true,
        );
    }

    // Hand the API time (plus corrections) over as an anchor. Guarded so a
    // drift nudge while paused does not leak to the overlay.
    function applyAutoClock(force = false) {
        if (timeMode !== "auto" || !globalTimerActive) return;

        const seconds = effectiveSecondsExact;
        if (seconds === null) return;

        time = formatAbsoluteTime(Math.floor(seconds));

        // heldAtPeriodEnd is an intermission being shown as the previous
        // period at its end time, so nothing is running there either. Nor is
        // it at the start of a period while a negative offset still holds the
        // clock at 00:00: let the overlay free-run from there and it would
        // count seconds the broadcast clock has not reached yet.
        const running =
            apiTimerOn && !heldAtPeriodEnd && period !== 5 && seconds > 0;
        pushClockState(running, seconds, force);

        // A clock message carries the score with it, but only when one is
        // actually sent - a score that changes between anchors needs its own.
        pushScoreIfChanged();
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

    // This tick keeps our own reading current and gives the transition and
    // resync checks somewhere to run. It is not what moves the clock on air:
    // the overlay does that from the last anchor, so this being throttled
    // behind the OBS window costs a late resync, never a frozen clock.
    $effect(() => {
        if (timeMode !== "auto" || !globalTimerActive) {
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

    // Sent on state changes only: the remaining time is what it is at the
    // moment of sending, and the overlay anchors it to its own clock.
    function pushBreak() {
        if ($connectionStatus !== "connected") return;
        obsWebSocket.sendBreakUpdate(
            breakActive,
            breakRemainingNow(),
            breakLabel,
        );
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
        pausePollingForBreak();
        pushBreak();
    }

    function endBreak() {
        breakActive = false;
        breakEndsAtMs = null;
        gameResumedAtMs = null;
        pollPausedUntilMs = null;
        breakInput = "";
        breakInputActive = false;
        pushBreak();
    }

    // The break is over for polling purposes a few seconds before it is over
    // on air, so the clock is already live when play resumes.
    function pausePollingForBreak() {
        pollPausedUntilMs =
            breakEndsAtMs === null
                ? null
                : breakEndsAtMs - BREAK_POLL_RESUME_SEC * 1000;
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
        pausePollingForBreak();

        breakInput = "";
        breakInputActive = false;
        pushBreak();
    }

    // The countdown needs no traffic of its own - the overlay runs it. This
    // only repeats the state so an overlay reloaded mid-break picks the panel
    // back up; being late costs nothing, because every push carries the
    // remaining time as of that moment.
    $effect(() => {
        if (!breakActive) return;

        const intervalId = setInterval(pushBreak, BREAK_RESYNC_MS);

        return () => clearInterval(intervalId);
    });

    async function pollScore() {
        // An intermission pauses the requests without stopping the interval,
        // so the deadline is checked here rather than gating the effect
        if (pollPausedUntilMs !== null) {
            if (Date.now() < pollPausedUntilMs) return;
            pollPausedUntilMs = null;
        }

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

                // Play has resumed - the break panel has to come off air. The
                // poll loop is the only thing that sees this, so it closes the
                // panel too: a timer here would freeze with a hidden tab.
                if (breakActive && apiTimerOn) {
                    if (gameResumedAtMs === null) gameResumedAtMs = receivedAt;
                    if (receivedAt - gameResumedAtMs >= BREAK_AUTOHIDE_MS) {
                        endBreak();
                    }
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

                // Fallback phase: the first reading of a running stretch, kept
                // until the clock stops so the fraction stays put across polls
                if (!apiTimerOn) {
                    freeAnchorWallMs = null;
                    freeAnchorSeconds = null;
                } else if (freeAnchorWallMs === null && seconds !== null) {
                    freeAnchorWallMs = receivedAt;
                    freeAnchorSeconds = seconds;
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
            if (globalTimerActive) {
                invalidateOverlayClock();
            } else {
                pauseOverlayClock();
            }
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
                invalidateOverlayClock();
                applyAutoClock();
            }

            broadcastPenalties();
            broadcastShootout();
            pushBreak();
            pushPlansi();
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
            driftOffset = Math.min(MAX_DRIFT, Math.max(-MAX_DRIFT, savedDrift));
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
                {#if pollingLive}
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

                {#if timeMode === "auto" && pollingLive}
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
                    <span class="field-label">Offset</span>
                    <div class="drift-control" class:idle={!apiTimerOn}>
                        <button
                            class="drift-btn"
                            onclick={(e) => {
                                adjustDrift(-1);
                                e.currentTarget.blur();
                            }}
                            disabled={driftOffset === -MAX_DRIFT}
                            title="Hold the clock on air back 1 s (↓)"
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
                            title="Run the clock on air 1 s ahead (↑)"
                        >+</button>
                        <button
                            class="drift-reset"
                            onclick={(e) => {
                                resetDrift();
                                e.currentTarget.blur();
                            }}
                            disabled={driftOffset === 0}
                            title="Back to the API time"
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
                                breakActive
                                    ? breakRemainingNow()
                                    : DEFAULT_BREAK_SECONDS,
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
                        : formatAbsoluteTime(DEFAULT_BREAK_SECONDS)}
                    maxlength="4"
                />

                {#if breakActive}
                    <span class="break-status" title="The overlay runs the countdown">
                        Ends {breakEndsAtLabel}
                    </span>

                    <span class="break-label-preview">
                        {formatPeriodLabel(period)}
                        {breakLabel}
                    </span>

                    {#if gameResumedAtMs !== null}
                        <span class="break-resumed">
                            Game running — panel closing
                        </span>
                    {:else if pollPausedUntilMs !== null}
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
        font-size: 13px;
        font-weight: bold;
        color: #b39ddb;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
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
