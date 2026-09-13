<script>
    import { onMount } from "svelte";
    import { fade, slide } from "svelte/transition";
    import { obsWebSocket, connectionStatus } from "./obsWebSocket.js";
    import Plansi from "./Plansi.svelte";

    // Game clock. The overlay owns the clock on air: it is handed a state
    // transition plus an anchor - the playing time at the instant the message
    // was sent - and works out the seconds from its own wall clock. Nothing
    // here depends on a message arriving on the second, which matters because
    // the admin page is an ordinary tab whose timers are throttled the moment
    // it goes behind another window. Nothing throttles a browser source.
    let internalSeconds = $state(0);
    let internalPeriod = $state(1);
    let internalPeriodLength = 1200;
    let clockRunning = $state(false);
    let clockInterval = null;

    // The anchor: playing time (fractional) at a known instant of this
    // machine's clock. The sender's wall time is never used - the two pages
    // may be on different machines - so the anchor is re-taken on arrival.
    let anchorWallMs = 0;
    let anchorSeconds = 0;

    // An anchor that agrees with what is already on air is ignored rather
    // than re-applied: the resync repeats while the clock runs, and
    // re-anchoring on every pulse would nudge the display.
    const ANCHOR_TOLERANCE_MS = 250;
    const CLOCK_TICK_MS = 50;

    // Match info state
    let homeScore = $state(0);
    let awayScore = $state(0);
    let homeTeamName = $state("Home");
    let awayTeamName = $state("Away");
    let homeTeamLogo = $state("");
    let awayTeamLogo = $state("");
    let timeMode = $state("manual");

    // Penalty state
    let homePenalties = $state([]);
    let awayPenalties = $state([]);
    let periodLengths = [0, 1200, 1200, 1200, 300, 0, 0];

    // Shootout state
    let homeShootout = $state([]);
    let awayShootout = $state([]);

    // Intermission panel. The operator hands over the remaining time whenever
    // it changes and this view counts it down itself, anchored to a wall-clock
    // instant of its own: the admin page is an ordinary tab whose timers are
    // throttled the moment it goes behind another window, and a countdown
    // driven from there would stall on air. Nothing throttles a browser source.
    let breakActive = $state(false);
    let breakEndsAtMs = $state(/** @type {number | null} */ (null));
    let breakLabel = $state("ERÄTAUKO");
    let breakKind = $state("intermission");
    let breakNowMs = $state(Date.now());

    let breakRemaining = $derived(
        breakEndsAtMs === null
            ? 0
            : Math.max(0, Math.ceil((breakEndsAtMs - breakNowMs) / 1000)),
    );

    $effect(() => {
        if (!breakActive) return;

        const intervalId = setInterval(() => (breakNowMs = Date.now()), 100);

        return () => clearInterval(intervalId);
    });

    // Plansi (lower third). Same contract as the break panel: the operator
    // owns what is on air, this view only renders what it is handed. The score
    // and the teams come from the state above, so a plansi only carries what
    // is specific to it.
    let plansiActive = $state(false);
    let plansiTabText = $state("");
    let plansiStrip = $state(/** @type {any} */ (null));

    // Goals and statistics, as last read off getMatch. Kept separately from
    // what is on air and outlives any one plansi: the operator pushes it when
    // the match data changes, and whichever full-screen plansi goes up next
    // draws on it. Null until the first one arrives, which is also what a
    // manually-run match never leaves - see the fallbacks below.
    let matchDetail = $state(/** @type {any} */ (null));

    function formatPeriodLabel(value) {
        if (value === 4) return "JA";
        if (value === 5) return "RL";
        return `${value}.`;
    }

    let breakTime = $derived.by(() => {
        const total = Math.max(0, breakRemaining);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    });

    // Derived display time that handles different modes and periods
    let displayTime = $derived.by(() => {
        // Always use internal clock since we manage everything internally now
        const minutes = Math.floor(internalSeconds / 60);
        const seconds = internalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    });

    // Use internal period for display
    let displayPeriod = $derived.by(() => {
        return internalPeriod;
    });

    // Intermission and result are the same panel with a different tab and a
    // different thing hanging under it, so they resolve to one Plansi.
    //
    // Both have two forms. With match data behind them they are full-screen:
    // the wordmark bar moves to the top of the frame, the score bar sits under
    // it, and the rest of the screen carries the goals or the statistics.
    // Without it - a manually-run match, or the API not reachable - they stay
    // the lower third they have always been, which is also what an intermission
    // falls back to at 0-0, where a timeline would be an empty screen.
    let plansi = $derived.by(() => {
        if (breakActive) {
            // A power break is a minute long and the picture is going to a
            // sponsor, not to a recap: the countdown and the score are the whole
            // job, so it keeps the lower third whatever the match data says.
            const goals =
                breakKind === "powerbreak" ? [] : (matchDetail?.timeline ?? []);
            if (goals.length) {
                return {
                    tabText: formatPeriodLabel(displayPeriod),
                    header: { countdown: breakTime, label: breakLabel },
                    body: { kind: "timeline", goals },
                };
            }

            return {
                // The period rides in the tab, so the label is the wordmark
                // alone - nothing is said twice.
                tabText: formatPeriodLabel(displayPeriod),
                strip: {
                    kind: "break",
                    countdown: breakTime,
                    label: breakLabel,
                },
            };
        }
        if (plansiActive) {
            // A plansi carrying its own strip is a goal one - a lower third by
            // definition, never the full-screen treatment.
            if (!plansiStrip && matchDetail?.stats?.length) {
                return {
                    // The wordmark bar says what this is, so the tab is free to
                    // carry how far the match went - "JA" is the whole story of
                    // a game that needed overtime.
                    tabText: formatPeriodLabel(displayPeriod),
                    header: { label: plansiTabText },
                    body: {
                        kind: "stats",
                        stats: matchDetail.stats,
                        scorers: matchDetail.scorers,
                    },
                };
            }

            return { tabText: plansiTabText, strip: plansiStrip };
        }
        return null;
    });

    // Get password from URL query parameter
    function getPasswordFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get("password") || "";
    }

    const password = getPasswordFromUrl();

    // One listener for the life of the page. obsWebSocket re-dials on its own
    // when the socket drops and keeps its listeners across that, so hanging
    // this off the connect call would register it again on every reconnect
    // and handle every event twice.
    function handleCustomEvent(event) {
        if (!event.eventData) return;

        const { eventName, eventData } = event.eventData;

        switch (eventName) {
            case "ClockControl":
                handleClockControl(eventData);
                break;
            case "ScoreUpdate":
                handleScoreUpdate(eventData);
                break;
            case "MatchInfo":
                handleMatchInfo(eventData);
                break;
            case "PenaltyUpdate":
                handlePenaltyUpdate(eventData);
                break;
            case "ShootoutUpdate":
                handleShootoutUpdate(eventData);
                break;
            case "BreakUpdate":
                handleBreakUpdate(eventData);
                break;
            case "PlansiUpdate":
                handlePlansiUpdate(eventData);
                break;
            case "MatchDetail":
                matchDetail = eventData;
                break;
        }
    }

    // Ask the operator for everything we missed, on every connection rather
    // than only the first: a browser source can be restarted at any moment,
    // and so can the socket. Waiting for the next resync instead means waiting
    // on a timer in a tab that may be throttled - an incoming socket message
    // is not.
    let requestedForConnection = false;
    $effect(() => {
        if ($connectionStatus !== "connected") {
            requestedForConnection = false;
            return;
        }

        if (requestedForConnection) return;
        requestedForConnection = true;
        obsWebSocket.sendClockControl("clock_request");
    });

    function handleClockControl(data) {
        const { action } = data;

        // Update score+period only from state-carrying events
        if (
            action === "clock_start" ||
            action === "clock_run" ||
            action === "clock_pause" ||
            action === "period_change"
        ) {
            if (data.homeScore !== undefined) homeScore = data.homeScore;
            if (data.awayScore !== undefined) awayScore = data.awayScore;

            if (data.period !== undefined && data.period !== internalPeriod) {
                handlePeriodChange(
                    data.period,
                    data.periodLength || internalPeriodLength,
                );
            }
        }

        switch (action) {
            case "clock_start":
                startInternalClock(data.time);
                break;
            case "clock_run":
                runInternalClock(data.seconds);
                break;
            case "clock_pause":
                pauseInternalClock(data.seconds);
                break;
            case "clock_adjust":
                adjustInternalClock(data.delta);
                break;
            case "clock_reset":
                resetInternalClock(data.time);
                break;
            case "period_change":
                handlePeriodChange(data.period, data.periodLength);
                break;
        }
    }

    function handleScoreUpdate(data) {
        homeScore = data.homeScore;
        awayScore = data.awayScore;
    }

    function handleMatchInfo(data) {
        if (data.homeTeamName) homeTeamName = data.homeTeamName;
        if (data.awayTeamName) awayTeamName = data.awayTeamName;
        if (data.homeTeamLogo) homeTeamLogo = data.homeTeamLogo;
        if (data.awayTeamLogo) awayTeamLogo = data.awayTeamLogo;
        if (data.timeMode) timeMode = data.timeMode;
        if (data.periodLengths) periodLengths = data.periodLengths;
    }

    function handlePenaltyUpdate(data) {
        if (data.homePenalties) homePenalties = data.homePenalties;
        if (data.awayPenalties) awayPenalties = data.awayPenalties;
    }

    function handleShootoutUpdate(data) {
        if (Array.isArray(data.homeAttempts)) homeShootout = data.homeAttempts;
        if (Array.isArray(data.awayAttempts)) awayShootout = data.awayAttempts;
    }

    // remainingSeconds is what was left when the message was sent, so it is
    // re-anchored here instead of being trusted as an absolute instant - the
    // two pages may be on different machines. Updates repeat while a break
    // runs, so a value we are already showing is ignored rather than re-
    // anchored: otherwise the resync would nudge the display every time.
    function handleBreakUpdate(data) {
        breakActive = !!data.active;
        if (data.label) breakLabel = data.label;
        if (data.kind) breakKind = data.kind;

        if (!breakActive) {
            breakEndsAtMs = null;
            return;
        }

        if (typeof data.remainingSeconds !== "number") return;

        breakNowMs = Date.now();
        const endsAt = breakNowMs + data.remainingSeconds * 1000;
        if (breakEndsAtMs === null || Math.abs(endsAt - breakEndsAtMs) > 1000) {
            breakEndsAtMs = endsAt;
        }
    }

    function handlePlansiUpdate(data) {
        plansiActive = !!data.active;
        if (typeof data.tabText === "string") plansiTabText = data.tabText;
        plansiStrip = data.strip ?? null;
    }

    function getAbsoluteSeconds() {
        let total = 0;
        for (let i = 1; i < internalPeriod; i++) total += periodLengths[i] || 0;
        return total + internalSeconds;
    }

    function penaltyRemaining(penalty) {
        const duration = penalty.type === '2min' ? 120 : 240;
        return Math.max(0, (penalty.startAbsolute + duration) - getAbsoluteSeconds());
    }

    function formatRemaining(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    function handlePeriodChange(newPeriod, periodLength) {
        if (newPeriod != internalPeriod) {
            internalPeriod = newPeriod;
            internalPeriodLength = periodLength;
            stopTicking();
            setAnchor(0);
        }
    }

    function parseTime(value) {
        const [minutes, seconds] = String(value).split(":").map(Number);
        return (minutes || 0) * 60 + (seconds || 0);
    }

    function clampSeconds(seconds) {
        // The shootout has no clock of its own
        if (internalPeriod === 5) return 0;

        const floored = Math.max(0, seconds);
        return internalPeriodLength > 0
            ? Math.min(floored, internalPeriodLength)
            : floored;
    }

    // Playing time the current anchor implies at a given instant
    function clockSecondsAt(nowMs) {
        if (!clockRunning || internalPeriod === 5) return anchorSeconds;
        return anchorSeconds + (nowMs - anchorWallMs) / 1000;
    }

    function setAnchor(seconds, nowMs = Date.now()) {
        anchorSeconds = seconds;
        anchorWallMs = nowMs;
        renderClock(nowMs);
    }

    function renderClock(nowMs = Date.now()) {
        internalSeconds = Math.floor(clampSeconds(clockSecondsAt(nowMs)));
    }

    function startTicking() {
        if (clockInterval) return;
        clockInterval = setInterval(() => renderClock(), CLOCK_TICK_MS);
    }

    function stopTicking() {
        clockRunning = false;
        if (clockInterval) {
            clearInterval(clockInterval);
            clockInterval = null;
        }
    }

    // Manual mode: resume from where we are, or from the time handed over.
    function startInternalClock(time) {
        const now = Date.now();
        const seconds = time ? parseTime(time) : clockSecondsAt(now);

        clockRunning = true;
        setAnchor(seconds, now);
        startTicking();
    }

    // Auto mode: "the clock is running and the playing time was S when I sent
    // this". S carries its fraction, so the second turns over on air where the
    // official clock turns it over rather than wherever the message landed.
    function runInternalClock(seconds) {
        if (typeof seconds !== "number") {
            startInternalClock(null);
            return;
        }

        const now = Date.now();
        const showing = clockSecondsAt(now);
        const wasRunning = clockRunning;

        clockRunning = true;
        startTicking();

        if (
            wasRunning &&
            Math.abs(showing - seconds) * 1000 <= ANCHOR_TOLERANCE_MS
        ) {
            return; // already showing it - leave the anchor alone
        }

        setAnchor(seconds, now);
    }

    // A whistle reaches us one poll late, so the value handed over here can be
    // behind what is on air. It is the official time and it wins: the clock
    // snaps back rather than holding a second the hall's board never showed.
    function pauseInternalClock(seconds) {
        const now = Date.now();
        const own = clockSecondsAt(now);
        stopTicking();

        if (typeof seconds === "number") {
            setAnchor(seconds, now);
            return;
        }

        // A sender that named the time already knows it; one that did not is
        // asking for ours back.
        setAnchor(own, now);
        sendClockSync();
    }

    function sendClockSync() {
        if ($connectionStatus !== "connected") return;
        obsWebSocket.sendClockControl("clock_sync", {
            time: displayTime,
            seconds: internalSeconds,
        });
    }

    function adjustInternalClock(delta) {
        const now = Date.now();
        setAnchor(clampSeconds(clockSecondsAt(now) + delta), now);
        sendClockSync();
    }

    // Moves the anchor; a running clock carries on from the new value.
    function resetInternalClock(time) {
        if (time) setAnchor(parseTime(time));
        sendClockSync();
    }

    onMount(() => {
        obsWebSocket.addEventListener("CustomEvent", handleCustomEvent);

        // A failed dial closes the socket, which starts obsWebSocket's own
        // retry loop - there is nothing to do here but not let the rejection
        // go unhandled.
        obsWebSocket
            .connect("ws://localhost:4455", password)
            .catch((error) => console.error("Failed to connect:", error));

        return () => {
            obsWebSocket.removeEventListener("CustomEvent", handleCustomEvent);
            obsWebSocket.disconnect();
            stopTicking();
        };
    });
</script>

<!--
  Nineties Headliner has proportional digits and no tnum feature, so anything
  that changes while on air has to be set on a fixed advance per glyph.
-->
{#snippet fixedDigits(value)}{#each String(value).split("") as ch}<span
            class="tick"
            class:colon={ch === ":"}>{ch}</span
        >{/each}{/snippet}

{#if plansi}
    <div class="plansi-layer" transition:fade={{ duration: 200 }}>
        <Plansi
            tabText={plansi.tabText}
            {homeTeamName}
            {awayTeamName}
            {homeTeamLogo}
            {awayTeamLogo}
            {homeScore}
            {awayScore}
            strip={plansi.strip}
            header={plansi.header}
            body={plansi.body}
        />
    </div>
{/if}

<div class="scoreboard" class:hidden={!!plansi}>
    {#if $connectionStatus === "connected"}
        <!-- Home team logo on transparent background -->

        <!-- Period indicator next to home logo -->
        <div class="period-indicator">
            {#if displayPeriod === 4}
                <span class="period">JA</span>
            {:else if displayPeriod === 5}
                <span class="period">RL</span>
            {:else}
                <span class="period">{displayPeriod}.</span>
            {/if}
        </div>

        <!-- Main scoreboard container -->
        <div class="main-scoreboard">
            <div class="team-section home">
                {#if homeTeamLogo}
                    <img
                        class="logo home-logo"
                        src={homeTeamLogo}
                        alt="{homeTeamName} Logo"
                    />
                {:else}
                    <div class="team-name">{homeTeamName}</div>
                {/if}
                {#if homePenalties.length > 0 && displayPeriod !== 5}
                    <div class="penalty-side home-penalties">
                        {#each homePenalties as penalty (penalty.id)}
                            {@const remaining = penaltyRemaining(penalty)}
                            <div class="penalty-pill" class:expired={remaining === 0} transition:slide={{ duration: 300 }}>
                                {#if penalty.playerNumber && penalty.playerNumber !== "0"}
                                    <span class="penalty-player">#{penalty.playerNumber}</span>
                                {/if}
                                <span class="penalty-time">{@render fixedDigits(formatRemaining(remaining))}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if displayPeriod === 5}
                    <div class="shootout-dots home-dots">
                        {#each Array(5) as _, i}
                            {#if i < homeShootout.length}
                                <span class="shootout-dot" class:goal={homeShootout[i]} class:miss={!homeShootout[i]}></span>
                            {:else}
                                <span class="shootout-dot pending"></span>
                            {/if}
                        {/each}
                        {#each Array(Math.max(0, Math.max(homeShootout.length, awayShootout.length) - 5)) as _, j}
                            {@const idx = j + 5}
                            {#if idx < homeShootout.length}
                                <span class="shootout-dot sudden-death" class:goal={homeShootout[idx]} class:miss={!homeShootout[idx]}></span>
                            {:else}
                                <span class="shootout-dot sudden-death pending"></span>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="score">
                <div class="team-score">{@render fixedDigits(homeScore)}</div>
                <div class="divider">-</div>
                <div class="team-score">{@render fixedDigits(awayScore)}</div>

                <!-- Time hanging below score (hidden entirely in period mode) -->
                {#if timeMode !== "period"}
                    <div class="game-info">
                        {#if displayPeriod === 5}
                            <!-- No time display for shootout -->
                        {:else}
                            <span class="time"
                                >{@render fixedDigits(displayTime)}</span
                            >
                        {/if}
                    </div>
                {/if}
            </div>

            <div class="team-section away">
                {#if awayTeamLogo}
                    <img
                        class="logo away-logo"
                        src={awayTeamLogo}
                        alt="{awayTeamName} Logo"
                    />
                {:else}
                    <div class="team-name">{awayTeamName}</div>
                {/if}
                {#if awayPenalties.length > 0 && displayPeriod !== 5}
                    <div class="penalty-side away-penalties">
                        {#each awayPenalties as penalty (penalty.id)}
                            {@const remaining = penaltyRemaining(penalty)}
                            <div class="penalty-pill" class:expired={remaining === 0} transition:slide={{ duration: 300 }}>
                                {#if penalty.playerNumber && penalty.playerNumber !== "0"}
                                    <span class="penalty-player">#{penalty.playerNumber}</span>
                                {/if}
                                <span class="penalty-time">{@render fixedDigits(formatRemaining(remaining))}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if displayPeriod === 5}
                    <div class="shootout-dots away-dots">
                        {#each Array(5) as _, i}
                            {#if i < awayShootout.length}
                                <span class="shootout-dot" class:goal={awayShootout[i]} class:miss={!awayShootout[i]}></span>
                            {:else}
                                <span class="shootout-dot pending"></span>
                            {/if}
                        {/each}
                        {#each Array(Math.max(0, Math.max(homeShootout.length, awayShootout.length) - 5)) as _, j}
                            {@const idx = j + 5}
                            {#if idx < awayShootout.length}
                                <span class="shootout-dot sudden-death" class:goal={awayShootout[idx]} class:miss={!awayShootout[idx]}></span>
                            {:else}
                                <span class="shootout-dot sudden-death pending"></span>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    {:else}
        <div class="connecting">Connecting to OBS...</div>
    {/if}
</div>

<style>
    /* The overlay is set in the league's face throughout. It ships a single
       weight, so nothing below may ask for bold - the browser would synthesise
       one and smear the letterforms. */
    @font-face {
        font-family: "Nineties Headliner";
        src:
            url("/ninetiesheadliner-regular-webfont.woff2") format("woff2"),
            url("/ninetiesheadliner-regular-webfont.woff") format("woff");
        font-weight: normal;
        font-display: swap;
    }

    /* The planssit are set in two faces, not one: the PSD's text layers put
       Nineties Headliner on the team names and the score, and Urbanist Bold
       on everything that is a label or a clock. Converted from
       broadcast_assets/fontit/Urbanist/static/Urbanist-Bold.ttf. */
    @font-face {
        font-family: "Urbanist";
        src:
            url("/urbanist-bold-webfont.woff2") format("woff2"),
            url("/urbanist-bold-webfont.woff") format("woff");
        font-weight: 700;
        font-display: swap;
    }

    .scoreboard {
        --scale: 1.2; /* Adjust this value to scale the entire scoreboard */
        position: fixed;
        top: 40px;
        left: 60px;
        display: flex;
        align-items: center;
        gap: calc(15px * var(--scale));
        font-family: "Nineties Headliner", "Arial Black", Arial, sans-serif;
        user-select: none;
        cursor: none;
        transform: scale(var(--scale));
        transform-origin: top left;
    }

    .period-indicator {
        background: #7e66bd;
        color: white;
        padding: 8px 12px;
        border-radius: 6px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    .logo {
        width: 60px;
        height: 60px;
        background: transparent;
        z-index: 5;
        filter: drop-shadow(4px 8px 2px rgba(72, 61, 139, 0.3));
    }

    .main-scoreboard {
        display: flex;
        align-items: center;
        gap: 12px;
        background: transparent;
    }

    .team-section {
        display: flex;
        align-items: center;
        gap: 10px;
        position: relative;
    }

    .team-name {
        font-size: 20px;
        color: #333;
    }

    .score {
        display: flex;
        align-items: center;
        background: #542c8c;
        border: 3px solid #7e66bd;
        /* Both faces default to a ~1.4 line-height, which was padding the box
           out by ~10px on its own. Pinning it to 1 makes the height fall out
           of the padding alone, close to the planssi's 51px at 1920. */
        line-height: 1;
        padding: 6px 8px;
        border-radius: 6px;
        gap: 4px;
        position: relative;
    }

    .team-score {
        font-size: 24px;
        color: white;
        min-width: 22px;
        text-align: center;
    }

    .divider {
        font-size: 18px;
        color: white;
    }

    .game-info {
        position: absolute;
        /* top: 100% lands on the inner edge of the score box border, which
           would clip it; +3px drops the clock past the border instead. */
        top: calc(100% + 3px);
        left: 50%;
        transform: translateX(-50%);
        background: #f5f5f5;
        color: #0a0a0a;
        padding: 3px 6px 5px;
        border-radius: 0 0 6px 6px;
        /* Kellopohja.png sets the clock at the same digit height as the
           score, so 24px here matches the .team-score above. */
        font-size: 24px;
        line-height: 1;
        min-width: 60px;
        text-align: center;
    }

    .time {
        display: inline-flex;
        justify-content: center;
    }

    .tick {
        display: inline-block;
        width: 0.56em;
        text-align: center;
    }

    .tick.colon {
        width: 0.26em;
    }

    .scoreboard.hidden {
        display: none;
    }

    /* Only here to carry the fade - Plansi positions itself */
    .plansi-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
    }

    .connecting {
        background: rgba(0, 0, 0, 0.7);
        padding: 10px 20px;
        border-radius: 5px;
        font-size: 14px;
        color: #ccc;
    }

    .penalty-side {
        position: absolute;
        top: 100%;
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-top: 6px;
        pointer-events: none;
    }

    .home-penalties {
        right: 0;
        align-items: flex-end;
    }

    .away-penalties {
        left: 0;
        align-items: flex-start;
    }

    .penalty-pill {
        display: flex;
        align-items: center;
        gap: 5px;
        background: #3f2069;
        color: rgba(255, 255, 255, 0.95);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 13px;
        white-space: nowrap;
    }

    .penalty-pill.expired {
        background: #2d2839;
        opacity: 0.5;
    }

    .penalty-player {
        opacity: 0.8;
    }

    .penalty-time {
        display: inline-flex;
    }

    .shootout-dots {
        position: absolute;
        top: 100%;
        display: grid;
        grid-template-columns: repeat(5, 14px);
        gap: 4px;
        margin-top: 6px;
        pointer-events: none;
    }

    .home-dots {
        right: 0;
        justify-items: end;
    }

    .away-dots {
        left: 0;
        justify-items: start;
    }

    .shootout-dot {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        box-sizing: border-box;
    }

    .shootout-dot.goal {
        background: #4caf50;
        box-shadow: 0 0 6px rgba(76, 175, 80, 0.6);
    }

    .shootout-dot.miss {
        background: #f44336;
        box-shadow: 0 0 6px rgba(244, 67, 54, 0.6);
    }

    .shootout-dot.pending {
        background: #555;
        opacity: 0.5;
        box-shadow: none;
    }

    .shootout-dot.sudden-death {
        border: 2px solid #ffd700;
    }

    .shootout-dot.sudden-death.pending {
        background: #555;
        opacity: 0.5;
        box-shadow: none;
    }
</style>
