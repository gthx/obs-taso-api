<script>
    import { onMount } from "svelte";
    import {
        obsWebSocket,
        connectionStatus,
        matchData,
    } from "./obsWebSocket.js";
    import { torneopalApi } from "./torneopalApi.js";

    let wsUrl = $state("ws://localhost:4455");
    let wsPassword = $state("");
    let isConnecting = $state(false);
    let connectionBoxExpanded = $state(false);

    // Torneopal API variables
    let torneopalApiKey = $state("");
    let matchId = $state("");
    let matchInfo = $state(null);

    // Local copy of match data for form binding
    let homeTeamName = $state("");
    let homeTeamScore = $state(0);
    let awayTeamName = $state("");
    let awayTeamScore = $state(0);
    let period = $state(1);
    let time = $state("20:00");

    // Subscribe to match data changes using $effect
    $effect(() => {
        if ($matchData) {
            homeTeamName = $matchData.homeTeam?.name || "";
            homeTeamScore = $matchData.homeTeam?.score || 0;
            awayTeamName = $matchData.awayTeam?.name || "";
            awayTeamScore = $matchData.awayTeam?.score || 0;
            period = $matchData.period || 1;
            time = $matchData.time || "20:00";
        }
    });

    async function connect() {
        isConnecting = true;
        try {
            await obsWebSocket.connect(wsUrl, wsPassword);
            // Try to load existing match data
            await obsWebSocket.getMatchData();
        } catch (error) {
            console.error("Connection failed:", error);
            alert(
                error.message ||
                    "Failed to connect to OBS WebSocket. Make sure OBS is running and WebSocket is enabled.",
            );
        } finally {
            isConnecting = false;
        }
    }
    
    function disconnect() {
        obsWebSocket.disconnect();
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
                // Fallback: show the URL in a prompt
                prompt("Copy this URL for the overlay:", url);
            });
    }

    async function updateMatchData() {
        const data = {
            homeTeam: { name: homeTeamName, score: homeTeamScore },
            awayTeam: { name: awayTeamName, score: awayTeamScore },
            period,
            time,
            lastUpdated: new Date().toISOString(),
        };

        await obsWebSocket.setMatchData(data);
    }

    function incrementScore(team) {
        if (team === "home") {
            homeTeamScore++;
        } else {
            awayTeamScore++;
        }
        updateMatchData();
    }

    function decrementScore(team) {
        if (team === "home" && homeTeamScore > 0) {
            homeTeamScore--;
        } else if (team === "away" && awayTeamScore > 0) {
            awayTeamScore--;
        }
        updateMatchData();
    }

    // Load saved connection settings from localStorage
    function loadSavedSettings() {
        const savedUrl = localStorage.getItem("obs-ws-url");
        const savedPassword = localStorage.getItem("obs-ws-password");

        if (savedUrl) {
            wsUrl = savedUrl;
        }
        if (savedPassword) {
            wsPassword = savedPassword;
        }

        // Load Torneopal settings
        const savedApiKey = torneopalApi.getStoredApiKey();

        if (savedApiKey) {
            torneopalApiKey = savedApiKey;
        }

        // Load stored match ID
        const savedMatchId = localStorage.getItem("torneopal-match-id");
        if (savedMatchId) {
            matchId = savedMatchId;

            // Load cached match data if available
            const cachedData = getStoredMatchData(savedMatchId);
            if (cachedData) {
                matchInfo = cachedData;
                // Also load team names into the form
                homeTeamName = cachedData.homeTeam || "Home";
                awayTeamName = cachedData.awayTeam || "Away";
            }
        }
    }

    // Save connection settings to localStorage
    function saveSettings() {
        localStorage.setItem("obs-ws-url", wsUrl);
        localStorage.setItem("obs-ws-password", wsPassword);
    }

    // Save Torneopal API settings
    function saveTorneopalSettings() {
        torneopalApi.setApiKey(torneopalApiKey);
        if (matchId) {
            localStorage.setItem("torneopal-match-id", matchId);
        }
    }

    // Store match data in localStorage by match ID
    function storeMatchData(matchId, matchData) {
        const key = `match-data-${matchId}`;
        localStorage.setItem(key, JSON.stringify(matchData));
    }

    // Retrieve match data from localStorage by match ID
    function getStoredMatchData(matchId) {
        const key = `match-data-${matchId}`;
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

    // Reset game - fetch match data from API and reset scores
    async function resetGame() {
        if (!matchId || !torneopalApiKey) {
            alert("Please enter both API key and Match ID");
            return;
        }

        // Save settings
        saveTorneopalSettings();

        // First, check if we have cached data
        const cachedData = getStoredMatchData(matchId);
        if (cachedData) {
            // Use cached data immediately
            matchInfo = cachedData;
            homeTeamName = cachedData.homeTeam || "Home";
            awayTeamName = cachedData.awayTeam || "Away";

            // Reset scores and game state
            homeTeamScore = 0;
            awayTeamScore = 0;
            period = 1;
            time = "20:00";

            // Update overlay
            await updateMatchData();
        }

        // Then fetch fresh data from API
        try {
            const result = await torneopalApi.getMatch(matchId);

            if (result && result.match) {
                const match = result.match;

                // Create match info object
                const newMatchInfo = {
                    homeTeam: match.team_A_name || "Home Team",
                    awayTeam: match.team_B_name || "Away Team",
                    date: match.date,
                    time: match.time,
                    venue: match.venue_name || "Venue",
                    category: match.category_name || "",
                };

                // Store the fresh data
                storeMatchData(matchId, newMatchInfo);

                // Update with fresh data
                matchInfo = newMatchInfo;
                homeTeamName = newMatchInfo.homeTeam;
                awayTeamName = newMatchInfo.awayTeam;

                // If we didn't have cached data, reset scores now
                if (!cachedData) {
                    homeTeamScore = 0;
                    awayTeamScore = 0;
                    period = 1;
                    time = "20:00";
                }

                // Update overlay with fresh data
                await updateMatchData();
            } else if (!cachedData) {
                // Only show error if we don't have cached data
                alert("Failed to fetch match data. Please check Match ID.");
            }
        } catch (error) {
            if (!cachedData) {
                // Only show error if we don't have cached data
                alert(`Failed to reset game: ${error.message}`);
            } else {
                console.error(
                    "Failed to fetch fresh data, using cached:",
                    error,
                );
            }
        }
    }

    onMount(async () => {
        loadSavedSettings();
        
        // Auto-connect to OBS WebSocket
        if ($connectionStatus === "disconnected") {
            await connect();
        }

        return () => {
            obsWebSocket.disconnect();
        };
    });
</script>

<div class="admin-container">
    <!-- Torneopal Top Bar -->
    <div class="torneopal-top-bar">
        <div class="top-bar-content">
            <div class="api-key-section">
                <label>Torneopal API Key:</label>
                <input
                    type="password"
                    placeholder="Enter API Key"
                    bind:value={torneopalApiKey}
                    onchange={saveTorneopalSettings}
                />
            </div>

            <div class="match-section">
                <label>Match ID:</label>
                <input
                    type="text"
                    placeholder="Enter Match ID"
                    bind:value={matchId}
                    onchange={saveTorneopalSettings}
                />
            </div>

            <button
                class="reset-game-btn"
                onclick={resetGame}
                disabled={!matchId || !torneopalApiKey}
                title="Load"
            >
                🔄 Load
            </button>
        </div>
    </div>

    {#if matchInfo}
        <div class="match-info-header">
            <div class="match-teams">
                {matchInfo.homeTeam} vs {matchInfo.awayTeam}
            </div>
            {#if matchInfo.category}
                <div class="match-category">{matchInfo.category}</div>
            {/if}
            <div class="match-details">
                📅 <span class="match-date"
                    >{new Date(
                        matchInfo.date + "T" + matchInfo.time,
                    ).toLocaleDateString("fi-FI", {
                        weekday: "short",
                        day: "numeric",
                        month: "numeric",
                        year: "numeric",
                    })}</span
                >
                🕐
                <span class="match-time">{matchInfo.time.substring(0, 5)}</span>
                📍 <span class="match-venue">{matchInfo.venue}</span>
            </div>
        </div>
    {/if}

    <div class="match-controls">
        <h2>Match Information</h2>

        <div class="teams-section">
            <div class="team home">
                <h3>Home Team</h3>
                <input
                    type="text"
                    placeholder="Team name"
                    bind:value={homeTeamName}
                    onchange={updateMatchData}
                />
                <div class="score-control">
                    <button
                        onclick={() => decrementScore("home")}
                        disabled={$connectionStatus !== "connected"}>-</button
                    >
                    <span class="score">{homeTeamScore}</span>
                    <button
                        onclick={() => incrementScore("home")}
                        disabled={$connectionStatus !== "connected"}>+</button
                    >
                </div>
            </div>

            <div class="team away">
                <h3>Away Team</h3>
                <input
                    type="text"
                    placeholder="Team name"
                    bind:value={awayTeamName}
                    onchange={updateMatchData}
                />
                <div class="score-control">
                    <button
                        onclick={() => decrementScore("away")}
                        disabled={$connectionStatus !== "connected"}>-</button
                    >
                    <span class="score">{awayTeamScore}</span>
                    <button
                        onclick={() => incrementScore("away")}
                        disabled={$connectionStatus !== "connected"}>+</button
                    >
                </div>
            </div>
        </div>

        <div class="game-info">
            <div class="period-control">
                <label>Period:</label>
                <select bind:value={period} onchange={updateMatchData}>
                    <option value={1}>1st</option>
                    <option value={2}>2nd</option>
                    <option value={3}>3rd</option>
                </select>
            </div>

            <div class="time-control">
                <label>Time:</label>
                <input
                    type="text"
                    bind:value={time}
                    onchange={updateMatchData}
                    pattern="[0-9]{(1, 2)}:[0-9]{2}"
                    placeholder="MM:SS"
                />
            </div>
        </div>

        <button
            class="update-button"
            onclick={updateMatchData}
            disabled={$connectionStatus !== "connected"}
        >
            Update Overlay
        </button>
    </div>

    <!-- OBS Preview Box -->
    <div
        class="obs-preview-box"
        class:connected={$connectionStatus === "connected"}
    >
        <div class="preview-header">
            <span class="preview-title">OBS Preview</span>
            {#if $connectionStatus === "connected"}
                <button class="copy-url-icon" onclick={copyOverlayUrl} title="Copy Overlay URL">
                    📋
                </button>
                <button class="disconnect-icon" onclick={disconnect} title="Disconnect">
                    ❌
                </button>
            {/if}
            <span class="preview-status {$connectionStatus}"
                >{$connectionStatus}</span
            >
        </div>

        {#if $connectionStatus !== "connected"}
            <div class="preview-auth-info">
                <h4>OBS WebSocket Configuration</h4>
                <div class="auth-field">
                    <label>URL:</label>
                    <input
                        type="text"
                        value={wsUrl}
                        onchange={(e) => {
                            wsUrl = e.target.value;
                            saveSettings();
                        }}
                        readonly
                    />
                </div>
                <div class="auth-field">
                    <label>Password:</label>
                    <input
                        type="password"
                        value={wsPassword}
                        onchange={(e) => {
                            wsPassword = e.target.value;
                            saveSettings();
                        }}
                        readonly
                    />
                </div>
                <button
                    class="connect-button"
                    onclick={connect}
                    disabled={isConnecting}
                >
                    {isConnecting ? "Connecting..." : "Connect to OBS"}
                </button>
            </div>
        {:else}
            <div class="preview-match-data">
                <div class="preview-teams">
                    <span class="home-preview">{homeTeamName || "Home"}</span>
                    <span class="score-preview"
                        >{homeTeamScore} - {awayTeamScore}</span
                    >
                    <span class="away-preview">{awayTeamName || "Away"}</span>
                </div>
                <div class="preview-game-info">
                    Period {period} | {time}
                </div>
            </div>
        {/if}
    </div>
</div>

<style>
    :global(body) {
        background: #121212;
        color: #ffffff;
        margin: 0;
    }

    .admin-container {
        max-width: 800px;
        margin: 0 auto;
        padding: 70px 20px 20px; /* Add top padding for the top bar */
        font-family: Arial, sans-serif;
        min-height: 100vh;
        position: relative;
    }

    h1 {
        text-align: center;
        color: #ffffff;
    }

    /* Match Info Header */
    .match-info-header {
        /*display: flex;*/
        align-items: center;
        justify-content: center;
        gap: 15px;
        margin-bottom: 30px;
        padding: 15px 20px;
        background: #1e1e1e;
        border-radius: 8px;
        border: 1px solid #333;
        font-size: 16px;
        flex-wrap: wrap;
    }

    .match-teams {
        font-weight: bold;
        color: #ffffff;
        font-size: 18px;
    }

    .match-separator {
        color: #555;
    }

    .match-date,
    .match-time,
    .match-venue {
        color: #aaa;
        white-space: nowrap;
    }

    /* Torneopal Top Bar */
    .torneopal-top-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #1a1a1a;
        border-bottom: 2px solid #333;
        padding: 10px 20px;
        z-index: 1001;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }

    .top-bar-content {
        max-width: 1200px;
        margin: 0 auto;
        display: flex;
        align-items: center;
        gap: 20px;
        flex-wrap: wrap;
    }

    .api-key-section,
    .match-section {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .api-key-section {
        flex: 0 1 auto;
    }

    .match-section {
        flex: 1 1 auto;
    }

    .top-bar-content label {
        font-size: 13px;
        color: #aaa;
        white-space: nowrap;
    }

    .top-bar-content input[type="password"],
    .top-bar-content input[type="text"] {
        width: 200px;
        padding: 5px 10px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 12px;
    }

    .reset-game-btn {
        padding: 6px 16px;
        background: #ff5722;
        font-size: 13px;
        font-weight: bold;
        margin-left: auto;
    }

    .reset-game-btn:hover:not(:disabled) {
        background: #ff7043;
    }

    .no-connection {
        color: #999;
        font-size: 13px;
        font-style: italic;
    }

    /* OBS Preview Box */
    .obs-preview-box {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1e1e1e;
        border: 2px solid #333;
        border-radius: 8px;
        padding: 16px;
        min-width: 300px;
        max-width: 400px;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        transition: all 0.3s ease;
    }

    .obs-preview-box.connected {
        border-color: #66bb6a;
    }

    .preview-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #333;
    }
    
    .preview-header .preview-status {
        margin-left: auto;
    }
    
    .copy-url-icon,
    .disconnect-icon {
        background: transparent;
        border: 1px solid #444;
        padding: 4px 8px;
        font-size: 16px;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
    }
    
    .copy-url-icon {
        margin-left: auto;
    }
    
    .copy-url-icon:hover {
        background: #2a2a2a;
        border-color: #ff9800;
    }
    
    .disconnect-icon:hover {
        background: #2a2a2a;
        border-color: #ef5350;
    }

    .preview-title {
        font-weight: bold;
        font-size: 14px;
        color: #fff;
    }

    .preview-status {
        font-size: 12px;
        text-transform: uppercase;
        font-weight: bold;
        padding: 2px 8px;
        border-radius: 4px;
        background: #2a2a2a;
    }

    .preview-status.connected {
        color: #66bb6a;
        background: #1b3a1f;
    }

    .preview-status.disconnected,
    .preview-status.error {
        color: #ef5350;
        background: #3a1f1f;
    }

    .preview-auth-info h4 {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: #aaa;
        font-weight: normal;
    }

    .auth-field {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
        gap: 10px;
    }

    .auth-field label {
        font-size: 12px;
        color: #888;
        min-width: 70px;
    }

    .auth-field input {
        flex: 1;
        padding: 6px 10px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 12px;
        font-family: monospace;
    }

    .connect-button {
        width: 100%;
        margin-top: 12px;
        padding: 8px;
        background: #2196f3;
        font-size: 13px;
    }

    .connect-button:hover {
        background: #42a5f5;
    }

    .preview-match-data {
        text-align: center;
    }

    .preview-teams {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 15px;
        margin-bottom: 8px;
        font-size: 16px;
    }

    .home-preview,
    .away-preview {
        font-weight: bold;
    }

    .score-preview {
        font-size: 24px;
        font-weight: bold;
        color: #fff;
    }

    .preview-game-info {
        color: #aaa;
        font-size: 14px;
        margin-bottom: 12px;
    }


    .connection-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .connection-form input {
        width: 100%;
        padding: 6px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #2a2a2a;
        color: #ffffff;
        font-size: 12px;
        box-sizing: border-box;
    }

    .connection-form input:focus {
        outline: none;
        border-color: #2196f3;
    }

    .connection-form button {
        padding: 6px 12px;
        font-size: 12px;
    }

    .connected-actions {
        text-align: center;
    }


    .connection-note {
        margin-top: 5px;
        color: #aaa;
        font-style: italic;
        text-align: center;
    }

    .connection-note small {
        font-size: 10px;
    }

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

    .match-controls {
        background: #1e1e1e;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid #333;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        transition: opacity 0.3s ease;
    }

    .match-controls h2 {
        color: #ffffff;
    }

    .teams-section {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 30px;
        margin-bottom: 20px;
    }

    .team {
        text-align: center;
    }

    .team input {
        width: 100%;
        padding: 8px;
        margin-bottom: 10px;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 16px;
        background: #2a2a2a;
        color: #ffffff;
    }

    .team input:focus {
        outline: none;
        border-color: #2196f3;
    }

    .team h3 {
        color: #ffffff;
    }

    .score-control {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 15px;
        margin-top: 10px;
    }

    .score {
        font-size: 48px;
        font-weight: bold;
        min-width: 80px;
        text-align: center;
        color: #ffffff;
    }

    .score-control button {
        width: 40px;
        height: 40px;
        font-size: 20px;
        padding: 0;
    }

    .game-info {
        display: flex;
        gap: 20px;
        justify-content: center;
        margin: 20px 0;
    }

    .period-control,
    .time-control {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    select,
    .time-control input {
        padding: 6px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #2a2a2a;
        color: #ffffff;
    }

    select:focus,
    .time-control input:focus {
        outline: none;
        border-color: #2196f3;
    }

    label {
        color: #ffffff;
    }


    .update-button {
        display: block;
        margin: 20px auto;
        padding: 12px 24px;
        font-size: 16px;
        background: #4caf50;
    }

    .update-button:hover {
        background: #66bb6a;
    }
</style>
