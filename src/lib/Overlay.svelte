<script>
    import { onMount } from "svelte";
    import { fade, slide } from "svelte/transition";
    import {
        obsWebSocket,
        connectionStatus,
        matchData,
    } from "./obsWebSocket.js";
    import InssiDivariLogo from "./InssiDivariLogo.svelte";

    let isConnected = $state(false);
    let retryCount = $state(0);
    const maxRetries = 10;

    // Internal clock state
    let internalSeconds = $state(0);
    let internalPeriod = $state(1);
    let internalPeriodLength = 1200;
    let clockRunning = $state(false);
    let clockInterval = null;
    let lastTick = 0;
    let accumulatedTime = 0;

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

    // Intermission panel. The operator owns the countdown, so this view only
    // renders what it is handed - same contract as the auto-mode clock.
    let breakActive = $state(false);
    let breakRemaining = $state(0);
    let breakLabel = $state("ERÄTAUKO");

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

    // Get password from URL query parameter
    function getPasswordFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get("password") || "";
    }

    const password = getPasswordFromUrl();

    async function connectToOBS() {
        retryCount++;
        try {
            await obsWebSocket.connect("ws://localhost:4455", password);
            isConnected = true;
            retryCount = 0; // Reset on successful connection

            // Load initial match data
            await obsWebSocket.getMatchData();

            // Listen for control signals
            obsWebSocket.addEventListener("CustomEvent", (event) => {
                if (event.eventData) {
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
                        case "MatchUpdate":
                            // Legacy support - can be removed later
                            console.log(
                                "Received legacy match update:",
                                eventData,
                            );
                            break;
                    }
                }
            });
        } catch (error) {
            console.error("Failed to connect:", error);

            if (retryCount < maxRetries) {
                // Retry connection after a delay
                setTimeout(connectToOBS, 2000);
            }
        }
    }

    function handleClockControl(data) {
        const { action } = data;

        // Update score+period only from state-carrying events
        if (
            action === "clock_start" ||
            action === "clock_pause" ||
            action === "period_change" ||
            action === "clock_set"
        ) {
            if (data.homeScore !== undefined) homeScore = data.homeScore;
            if (data.awayScore !== undefined) awayScore = data.awayScore;
        }

        // Update period from state-carrying events
        if (
            action === "clock_start" ||
            action === "clock_pause" ||
            action === "period_change" ||
            action === "clock_set"
        ) {
            if (data.period !== undefined && data.period !== internalPeriod) {
                handlePeriodChange(data.period, data.periodLength || internalPeriodLength);
            }
        }

        switch (action) {
            case "clock_start":
                startInternalClock(data.time);
                break;
            case "clock_pause":
                pauseInternalClock();
                break;
            case "clock_adjust":
                adjustInternalClock(data.delta);
                break;
            case "clock_reset":
                resetInternalClock(data.time);
                break;
            case "clock_set":
                setInternalClock(data);
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

    function handleBreakUpdate(data) {
        breakActive = !!data.active;
        if (typeof data.remainingSeconds === "number") {
            breakRemaining = data.remainingSeconds;
        }
        if (data.label) breakLabel = data.label;
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
            internalSeconds = 0;
            internalPeriodLength = periodLength;
        }
    }

    function startInternalClock(time) {
        // Only update time/period if explicitly provided (not on resume)
        if (time) {
            // Convert time string to seconds
            const [minutes, seconds] = time.split(":").map(Number);
            internalSeconds = minutes * 60 + seconds;
        }

        if (clockInterval) return; // Already running

        clockRunning = true;
        lastTick = Date.now();
        accumulatedTime = 0;

        // Use 60fps (16.67ms) for smooth accumulation
        clockInterval = setInterval(handleClockTick, 16);
    }

    function handleClockTick() {
        if (!clockRunning) return;

        // Don't increment time during shootout (period 5)
        if (internalPeriod === 5) return;

        const now = Date.now();
        const diff = now - lastTick;
        lastTick = now;
        accumulatedTime += diff;

        // Update internal seconds when 1000ms have accumulated
        if (accumulatedTime >= 1000) {
            accumulatedTime -= 1000; // Keep remainder for next second
            internalSeconds++;

            // Different max times based on period
            const maxSeconds = internalPeriodLength;

            // Stop at max time for current period
            if (internalSeconds >= maxSeconds) {
                internalSeconds = maxSeconds;
            }
        }
    }

    function stopTicking() {
        clockRunning = false;
        if (clockInterval) {
            clearInterval(clockInterval);
            clockInterval = null;
        }
        accumulatedTime = 0;
    }

    function pauseInternalClock() {
        stopTicking();

        // Report current time back to operator
        sendClockSync();
    }

    // Auto mode: the operator polls the API once per second and sends the
    // playing time as an absolute value, so the clock does not tick locally
    // and may jump backwards. No clock_sync here - the API is the authority.
    function setInternalClock(data) {
        stopTicking();

        if (typeof data.seconds === "number") {
            internalSeconds = Math.max(0, data.seconds);
        } else if (data.time) {
            const [minutes, seconds] = data.time.split(":").map(Number);
            internalSeconds = minutes * 60 + (seconds || 0);
        }
    }

    function sendClockSync() {
        if (!isConnected) return;
        obsWebSocket.sendClockControl("clock_sync", {
            time: displayTime,
            seconds: internalSeconds,
        });
    }

    function adjustInternalClock(delta) {
        accumulatedTime = 0;
        internalSeconds += delta;

        // Don't go below 0:00
        if (internalSeconds < 0) {
            internalSeconds = 0;
        }

        // Different max times based on period
        let maxSeconds;
        if (internalPeriod === 4) {
            maxSeconds = 300; // 5:00 for extra time (JA)
        } else if (internalPeriod === 5) {
            maxSeconds = 0; // No time counting for shootout
        } else {
            maxSeconds = 1200; // 20:00 for regular periods (1-3)
        }

        if (internalSeconds > maxSeconds) {
            internalSeconds = maxSeconds;
        }
        sendClockSync();
    }

    function resetInternalClock(time) {
        if (time) {
            // Convert time string to seconds
            const [minutes, seconds] = time.split(":").map(Number);
            internalSeconds = minutes * 60 + seconds;
        }

        // If clock was running, restart it with new time
        if (clockRunning && clockInterval) {
            pauseInternalClock();
            startInternalClock(time);
        }
        sendClockSync();
    }

    onMount(() => {
        connectToOBS();

        return () => {
            obsWebSocket.disconnect();
            pauseInternalClock();
        };
    });
</script>

{#if breakActive}
    <!--
      Rebuilt from inssidivari_eratauko_planssi.png rather than using it:
      bar 1170x107 at 1920x1080, fill #542c8c, 3px #7e66bd border, 10px radius,
      all measured off the asset. The wordmark is real text, so it can say
      something other than ERÄTAUKO without a new graphic.
    -->
    <div class="break-panel" transition:fade={{ duration: 200 }}>
        <div class="break-combo">
            {#if homeTeamLogo}
                <img class="break-logo" src={homeTeamLogo} alt={homeTeamName} />
            {:else}
                <span class="break-team">{homeTeamName}</span>
            {/if}

            <div class="break-score-box">
                <span class="break-team-score">{homeScore}</span>
                <span class="break-divider">-</span>
                <span class="break-team-score">{awayScore}</span>
            </div>

            {#if awayTeamLogo}
                <img class="break-logo" src={awayTeamLogo} alt={awayTeamName} />
            {:else}
                <span class="break-team">{awayTeamName}</span>
            {/if}
        </div>

        <div class="break-bar">
            <div class="break-brand">
                <InssiDivariLogo />
            </div>

            <div class="break-countdown">{breakTime}</div>

            <div class="break-label">{breakLabel}</div>
        </div>
    </div>
{/if}

<div class="scoreboard" class:hidden={breakActive}>
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
                                <span class="penalty-time">{formatRemaining(remaining)}</span>
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
                <div class="team-score">{homeScore}</div>
                <div class="divider">-</div>
                <div class="team-score">{awayScore}</div>

                <!-- Time hanging below score (hidden entirely in period mode) -->
                {#if timeMode !== "period"}
                    <div class="game-info">
                        {#if displayPeriod === 5}
                            <!-- No time display for shootout -->
                        {:else}
                            <span class="time">{displayTime}</span>
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
                                <span class="penalty-time">{formatRemaining(remaining)}</span>
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
    {:else if $connectionStatus === "disconnected" && retryCount < maxRetries}
        <div class="connecting">
            Connecting to OBS... (Attempt {retryCount}/{maxRetries})
        </div>
    {/if}
</div>

<style>
    .scoreboard {
        --scale: 1.2; /* Adjust this value to scale the entire scoreboard */
        position: fixed;
        top: 40px;
        left: 60px;
        display: flex;
        align-items: center;
        gap: calc(15px * var(--scale));
        font-family: "Arial Black", Arial, sans-serif;
        user-select: none;
        cursor: none;
        transform: scale(var(--scale));
        transform-origin: top left;
    }

    .period-indicator {
        background: #8b7fc7;
        color: white;
        padding: 8px 12px;
        border-radius: 6px;
        font-weight: bold;
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
        font-weight: bold;
        color: #333;
    }

    .score {
        display: flex;
        align-items: center;
        background: #5b4b99;
        padding: 6px 12px;
        border-radius: 6px;
        gap: 8px;
        position: relative;
    }

    .team-score {
        font-size: 24px;
        font-weight: bold;
        color: white;
        min-width: 30px;
        text-align: center;
    }

    .divider {
        font-size: 20px;
        font-weight: bold;
        color: white;
    }

    .game-info {
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: #f5f5f5;
        color: #333;
        padding: 2px 10px 6px;
        border-radius: 0 0 6px 6px;
        font-size: 16px;
        font-weight: bold;
        min-width: 60px;
        text-align: center;
    }

    .time {
        font-variant-numeric: tabular-nums;
    }

    .scoreboard.hidden {
        display: none;
    }

    /* Intermission panel, measured off the broadcast asset */
    @font-face {
        font-family: "Nineties Headliner";
        src:
            url("/ninetiesheadliner-regular-webfont.woff2") format("woff2"),
            url("/ninetiesheadliner-regular-webfont.woff") format("woff");
        font-weight: normal;
        font-display: swap;
    }

    .break-panel {
        position: fixed;
        inset: 0;
        font-family: "Arial Black", Arial, sans-serif;
        color: #fff;
        user-select: none;
        cursor: none;
    }

    .break-bar {
        position: absolute;
        left: 19.58%; /* 376/1920 */
        top: 78.06%; /* 843/1080 */
        width: 60.94%; /* 1170/1920 */
        height: 9.91%; /* 107/1080 */
        box-sizing: border-box;
        display: flex;
        align-items: center;
        background: #542c8c;
        border: 0.26vw solid #7e66bd; /* 5px */
        border-radius: 0.52vw; /* 10px */
        padding: 0 2.4%; /* 28/1170 */
    }

    .break-brand {
        width: 22.9%; /* 268/1170 */
        height: 70%;
        flex-shrink: 0;
    }

    .break-label {
        flex-shrink: 0;
        margin-left: auto;
        font-family: "Nineties Headliner", "Arial Black", Arial, sans-serif;
        font-size: 1.9vw;
        letter-spacing: 0.02em;
        white-space: nowrap;
    }

    /* Score combo sits above the bar, mirroring the scoreboard's treatment */
    .break-combo {
        position: absolute;
        bottom: 22.7%;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.8vw;
    }

    .break-logo {
        width: 3.75vw;
        height: 3.75vw;
        object-fit: contain;
        flex-shrink: 0;
        filter: drop-shadow(4px 8px 2px rgba(72, 61, 139, 0.3));
    }

    .break-team {
        font-size: 1.25vw;
        color: #333;
        white-space: nowrap;
    }

    .break-score-box {
        display: flex;
        align-items: center;
        gap: 0.42vw;
        background: #5b4b99;
        padding: 0.31vw 0.63vw;
        border-radius: 0.31vw;
    }

    .break-team-score {
        font-size: 1.5vw;
        min-width: 1.88vw;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }

    .break-divider {
        font-size: 1.25vw;
    }

    /* Centred in the bar regardless of what flanks it */
    .break-countdown {
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 3.4vw;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
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
        background: #463882;
        color: rgba(255, 255, 255, 0.95);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: bold;
        white-space: nowrap;
    }

    .penalty-pill.expired {
        background: #3a3a3a;
        opacity: 0.5;
    }

    .penalty-player {
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
    }

    .penalty-time {
        font-variant-numeric: tabular-nums;
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
