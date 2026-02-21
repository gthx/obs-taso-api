<script>
    import { onMount } from "svelte";
    import {
        obsWebSocket,
        connectionStatus,
        matchData,
    } from "./obsWebSocket.js";

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
            action === "period_change"
        ) {
            if (data.homeScore !== undefined) homeScore = data.homeScore;
            if (data.awayScore !== undefined) awayScore = data.awayScore;
        }

        // Update period from state-carrying events
        if (
            action === "clock_start" ||
            action === "clock_pause" ||
            action === "period_change"
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

    function pauseInternalClock() {
        clockRunning = false;
        if (clockInterval) {
            clearInterval(clockInterval);
            clockInterval = null;
        }
        accumulatedTime = 0;

        // Report current time back to operator
        sendClockSync();
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

<div class="scoreboard">
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
            </div>

            <div class="score">
                <div class="team-score">{homeScore}</div>
                <div class="divider">-</div>
                <div class="team-score">{awayScore}</div>

                <!-- Time hanging below score -->
                <div class="game-info">
                    {#if displayPeriod === 4}
                        <span class="time">{displayTime}</span>
                    {:else if displayPeriod === 5}
                        <!-- No time display for shootout -->
                    {:else if timeMode === "period"}
                        <span class="time period-mode">--:--</span>
                    {:else}
                        <span class="time">{displayTime}</span>
                    {/if}
                </div>
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

    .time.period-mode {
        opacity: 0.7;
    }

    .connecting {
        background: rgba(0, 0, 0, 0.7);
        padding: 10px 20px;
        border-radius: 5px;
        font-size: 14px;
        color: #ccc;
    }
</style>
