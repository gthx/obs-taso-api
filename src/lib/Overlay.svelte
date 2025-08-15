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

            // Listen for match updates
            obsWebSocket.addEventListener("CustomEvent", (event) => {
                if (
                    event.eventData &&
                    event.eventData.eventName === "MatchUpdate"
                ) {
                    console.log(
                        "Received match update:",
                        event.eventData.eventData,
                    );
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

    onMount(() => {
        connectToOBS();

        return () => {
            obsWebSocket.disconnect();
        };
    });
</script>

<div class="scoreboard">
    {#if $connectionStatus === "connected" && $matchData}
        <!-- Home team logo on transparent background -->

        <!-- Main scoreboard container -->
        <div class="main-scoreboard">
            <div class="team-section home">
                {#if $matchData.homeTeam?.logo}
                    <img
                        class="logo home-logo"
                        src={$matchData.homeTeam.logo}
                        alt="{$matchData.homeTeam?.name} Logo"
                    />
                {/if}
                <!-- <div class="team-name">{$matchData.homeTeam?.name}</div> -->
                <div class="team-score">{$matchData.homeTeam?.score || 0}</div>
            </div>

            <div class="divider">-</div>

            <div class="team-section away">
                {#if $matchData.awayTeam?.logo}
                    <img
                        class="logo away-logo"
                        src={$matchData.awayTeam.logo}
                        alt="{$matchData.awayTeam?.name} Logo"
                    />
                {/if}
                <!-- <div class="team-name">{$matchData.awayTeam?.name}</div> -->
                <div class="team-score">{$matchData.awayTeam?.score || 0}</div>
            </div>
        </div>

        <!-- Away team logo on transparent background -->

        <!-- Period and time hanging below -->
        <div class="game-info">
            {#if $matchData.period === 4}
                <span class="period">JA</span>
                <span class="time">{$matchData.time}</span>
            {:else if $matchData.period === 5}
                <span class="period">RL</span>
            {:else}
                <span class="period">{$matchData.period || 1}.</span>
                {#if !$matchData.time}
                    <span class="time period-mode">--:--</span>
                {:else}
                    <span class="time">{$matchData.time}</span>
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
