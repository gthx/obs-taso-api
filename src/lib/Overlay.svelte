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

        switch (action) {
            case "clock_start":
                startInternalClock(data.time, data.period);
                break;
            case "clock_pause":
                pauseInternalClock();
                break;
            case "clock_adjust":
                adjustInternalClock(data.delta);
                break;
            case "clock_reset":
                resetInternalClock(data.time, data.period);
                break;
            case "period_change":
                handlePeriodChange(data.period);
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

    function handlePeriodChange(newPeriod) {
        if (newPeriod != internalPeriod) {
            internalPeriod = newPeriod;
            internalSeconds = 0;
        }
    }

    function startInternalClock(time, period) {
        // Only update time/period if explicitly provided (not on resume)
        if (time !== undefined) {
            // Convert time string to seconds
            const [minutes, seconds] = time.split(":").map(Number);
            internalSeconds = minutes * 60 + seconds;
        }
        if (period !== undefined) {
            internalPeriod = period;
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
            let maxSeconds;
            if (internalPeriod === 4) {
                maxSeconds = 300; // 5:00 for extra time (JA)
            } else {
                maxSeconds = 1200; // 20:00 for regular periods (1-3)
            }

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
    }

    function adjustInternalClock(delta) {
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
    }

    function resetInternalClock(time, period) {
        if (time) {
            // Convert time string to seconds
            const [minutes, seconds] = time.split(":").map(Number);
            internalSeconds = minutes * 60 + seconds;
        }
        if (period) internalPeriod = period;

        // If clock was running, restart it with new time
        if (clockRunning && clockInterval) {
            pauseInternalClock();
            startInternalClock(time, internalPeriod);
        }
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

        <!-- Main scoreboard container -->
        <div class="main-scoreboard">
            <div class="team-section home">
                {#if homeTeamLogo}
                    <img
                        class="logo home-logo"
                        src={homeTeamLogo}
                        alt="{homeTeamName} Logo"
                    />
                {/if}
                <!-- <div class="team-name">{homeTeamName}</div> -->
                <div class="team-score">{homeScore}</div>
            </div>

            <div class="divider">-</div>

            <div class="team-section away">
                {#if awayTeamLogo}
                    <img
                        class="logo away-logo"
                        src={awayTeamLogo}
                        alt="{awayTeamName} Logo"
                    />
                {/if}
                <!-- <div class="team-name">{awayTeamName}</div> -->
                <div class="team-score">{awayScore}</div>
            </div>
        </div>

        <!-- Away team logo on transparent background -->

        <!-- Period and time hanging below -->
        <div class="game-info">
            {#if displayPeriod === 4}
                <span class="period">JA</span>
                <span class="time">{displayTime}</span>
            {:else if displayPeriod === 5}
                <span class="period">RL</span>
            {:else}
                <span class="period">{displayPeriod}.</span>
                {#if timeMode === "period"}
                    <span class="time period-mode">--:--</span>
                {:else}
                    <span class="time">{displayTime}</span>
                {/if}
            {/if}
        </div>
    {:else if $connectionStatus === "disconnected" && retryCount < maxRetries}
        <div class="connecting">
            Connecting to OBS... (Attempt {retryCount}/{maxRetries})
        </div>
    {/if}
</div>

<style>
    .scoreboard {
        position: fixed;
        top: 24px;
        left: 48px;
        display: flex;
        align-items: flex-start;
        gap: 0;
        font-family: "Arial Black", Arial, sans-serif;
        color: white;
        text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
        user-select: none;
        cursor: none;
    }

    .logo {
        width: 90px;
        height: 90px;
        background: transparent;
        z-index: 5;
        filter: drop-shadow(8px 16px 2px rgba(72, 61, 139, 0.5));
    }

    .away-logo {
        margin-top: 12px;
    }

    .main-scoreboard {
        display: flex;
        align-items: center;
        /*background: linear-gradient(135deg, #6a5acd 0%, #483d8b 100%);*/
        background: linear-gradient(135deg, #c8b432 0%, #eab92a 100%);
        height: 70px;
        top: 20px;
        padding: 0 20px;
        border-radius: 8px;
        position: relative;
    }

    .team-section {
        display: flex;
        align-items: center;
        gap: 15px;
    }

    .team-section.home {
        flex-direction: row;
    }

    .team-section.away {
        flex-direction: row-reverse;
    }

    .team-name {
        font-size: 28px;
        font-weight: bold;
        min-width: 80px;
    }

    .team-score {
        font-size: 48px;
        font-weight: bold;
        min-width: 60px;
        text-align: center;
    }

    .divider {
        font-size: 36px;
        font-weight: bold;
        margin: 0 20px;
        color: white;
    }

    .game-info {
        position: absolute;
        top: 90px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(127, 127, 127, 0.7);
        padding: 0 8px 8px;
        border-radius: 0 0 8px 8px;
        font-size: 20px;
        font-weight: bold;
        text-align: center;
        min-width: 120px;
        backdrop-filter: blur(5px);
    }

    .period {
        color: #ffd700;
        margin-right: 8px;
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
        position: fixed;
        top: 20px;
        left: 20px;
    }
</style>
