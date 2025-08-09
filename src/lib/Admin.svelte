<script>
    import { onMount } from "svelte";
    import {
        obsWebSocket,
        connectionStatus,
        matchData,
    } from "./obsWebSocket.js";
    import { torneopalApi } from "./torneopalApi.js";
    import NumericInput from "./NumericInput.svelte";

    let wsUrl = $state("ws://localhost:4455");
    let wsPassword = $state("");
    let isConnecting = $state(false);
    let connectionBoxExpanded = $state(false);
    let obsPreviewExpanded = $state(true);
    let showMatchPopup = $state(false);
    
    // Score control state
    let scoreMode = $state("auto"); // "auto" or "manual"
    let autoScoreInterval = null;
    let apiScores = $state(null);
    let isPollingScores = $state(false);
    
    // Time control state
    let timeMode = $state("auto"); // "auto", "manual", or "period"

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
    
    // Score control functions
    function setScoreMode(mode) {
        scoreMode = mode;
        localStorage.setItem("score-mode", mode);
        
        if (mode === "auto" && matchId) {
            startScorePolling();
        } else {
            stopScorePolling();
        }
    }
    
    // Time control functions
    function setTimeMode(mode) {
        timeMode = mode;
        localStorage.setItem("time-mode", mode);
        
        // Update overlay when time mode changes
        updateMatchData();
    }
    
    async function startScorePolling() {
        if (!matchId || !torneopalApiKey || autoScoreInterval) {
            return;
        }
        
        isPollingScores = true;
        
        // Initial score fetch
        await fetchCurrentScore();
        
        // Set up polling interval (5 seconds)
        autoScoreInterval = setInterval(async () => {
            await fetchCurrentScore();
        }, 5000);
    }
    
    function stopScorePolling() {
        if (autoScoreInterval) {
            clearInterval(autoScoreInterval);
            autoScoreInterval = null;
        }
        isPollingScores = false;
    }
    
    async function fetchCurrentScore() {
        if (!matchId || !torneopalApiKey) {
            return;
        }
        
        try {
            const result = await torneopalApi.getScore(matchId);
            if (result && result.score) {
                apiScores = result.score;
                
                // Update scores if in auto mode
                if (scoreMode === "auto") {
                    // Only update scores if they have valid values from the API
                    if (result.score.live_A !== "" && result.score.live_A !== null && result.score.live_A !== undefined) {
                        const newHomeScore = parseInt(result.score.live_A);
                        if (!isNaN(newHomeScore)) {
                            homeTeamScore = newHomeScore;
                        }
                    }
                    
                    if (result.score.live_B !== "" && result.score.live_B !== null && result.score.live_B !== undefined) {
                        const newAwayScore = parseInt(result.score.live_B);
                        if (!isNaN(newAwayScore)) {
                            awayTeamScore = newAwayScore;
                        }
                    }
                    
                    // Update period and time based on time mode
                    if (timeMode === "auto") {
                        if (result.score.live_period && result.score.live_period !== "-1" && result.score.live_period !== "") {
                            const newPeriod = parseInt(result.score.live_period);
                            if (!isNaN(newPeriod) && newPeriod > 0) {
                                period = newPeriod;
                            }
                        }
                        
                        if (result.score.live_time_mmss && result.score.live_time_mmss !== "" && result.score.live_time_mmss !== "00:00") {
                            time = result.score.live_time_mmss;
                        }
                    }
                    
                    // Update overlay
                    await updateMatchData();
                }
            }
        } catch (error) {
            console.error("Failed to fetch current score:", error);
        }
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
            homeTeam: { 
                name: homeTeamName, 
                score: homeTeamScore,
                logo: matchInfo?.homeTeamLogo || ""
            },
            awayTeam: { 
                name: awayTeamName, 
                score: awayTeamScore,
                logo: matchInfo?.awayTeamLogo || ""
            },
            period,
            time: timeMode === "period" ? "" : time, // Empty time in period mode
            timeMode,
            lastUpdated: new Date().toISOString(),
        };

        await obsWebSocket.setMatchData(data);
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
                    homeTeamLogo: match.club_A_crest || "",
                    awayTeamLogo: match.club_B_crest || "",
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
        
        // Start score polling if in auto mode
        if (scoreMode === "auto" && matchInfo) {
            startScorePolling();
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
            stopScorePolling();
        };
    });
</script>

    <!-- Torneopal Top Bar -->
    <div class="torneopal-top-bar">
        <div class="top-bar-content">
            {#if matchInfo}
                <div class="match-info-section">
                    <div class="match-teams-info">
                        {#if matchInfo.homeTeamLogo}
                            <img 
                                src={matchInfo.homeTeamLogo} 
                                alt={matchInfo.homeTeam}
                                class="team-logo"
                            />
                        {/if}
                        <span class="team-name">{matchInfo.homeTeam}</span>
                        <span class="vs">vs</span>
                        <span class="team-name">{matchInfo.awayTeam}</span>
                        {#if matchInfo.awayTeamLogo}
                            <img 
                                src={matchInfo.awayTeamLogo} 
                                alt={matchInfo.awayTeam}
                                class="team-logo"
                            />
                        {/if}
                        {#if matchInfo.category}
                            <span class="match-category">{matchInfo.category}</span>
                        {/if}
                    </div>
                    <div class="match-details-info">
                        <span class="match-date">
                            📅 {new Date(
                                matchInfo.date + "T" + matchInfo.time,
                            ).toLocaleDateString("fi-FI", {
                                weekday: "short",
                                day: "numeric",
                                month: "numeric",
                            })}
                        </span>
                        <span class="match-time">🕐 {matchInfo.time.substring(0, 5)}</span>
                        <span class="match-venue">📍 {matchInfo.venue}</span>
                        <button 
                            class="change-match-btn"
                            onclick={() => showMatchPopup = true}
                            title="Change Match"
                        >
                            ⚙️
                        </button>
                    </div>
                </div>
            {:else}
                <button 
                    class="load-match-btn"
                    onclick={() => showMatchPopup = true}
                    title="Load Match"
                >
                    🔄 Load Match
                </button>
            {/if}
        </div>
    </div>
    
    <!-- Match Settings Popup -->
    {#if showMatchPopup}
        <div class="popup-overlay" onclick={(e) => { if (e.target === e.currentTarget) showMatchPopup = false; }}>
            <div class="popup-modal">
                <div class="popup-header">
                    <h3>Match Settings</h3>
                    <button class="popup-close" onclick={() => showMatchPopup = false}>✕</button>
                </div>
                <div class="popup-content">
                    <div class="popup-field">
                        <label for="api-key">Torneopal API Key:</label>
                        <input
                            id="api-key"
                            type="password"
                            placeholder="Enter API Key"
                            bind:value={torneopalApiKey}
                            onchange={saveTorneopalSettings}
                        />
                    </div>
                    
                    <div class="popup-field">
                        <label for="match-id">Match ID:</label>
                        <input
                            id="match-id"
                            type="text"
                            placeholder="Enter Match ID"
                            bind:value={matchId}
                            onchange={saveTorneopalSettings}
                        />
                    </div>
                    
                    <div class="popup-actions">
                        <button
                            class="popup-load-btn"
                            onclick={async () => {
                                await resetGame();
                                if (matchInfo) {
                                    showMatchPopup = false;
                                }
                            }}
                            disabled={!matchId || !torneopalApiKey}
                        >
                            🔄 Load Match
                        </button>
                        <button
                            class="popup-cancel-btn"
                            onclick={() => showMatchPopup = false}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <!-- Score Controls Section -->
    {#if matchInfo}
        <div class="score-controls" class:auto-mode={scoreMode === "auto"}>
            <div class="score-mode-selector">
                <span class="score-label">Score:</span>
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
            
            <div class="score-display">
                <NumericInput 
                    bind:value={homeTeamScore}
                    disabled={scoreMode === "auto" || $connectionStatus !== "connected"}
                    autoMode={scoreMode === "auto"}
                    min={0}
                    onchange={updateMatchData}
                />
                
                <span class="score-separator">-</span>
                
                <NumericInput 
                    bind:value={awayTeamScore}
                    disabled={scoreMode === "auto" || $connectionStatus !== "connected"}
                    autoMode={scoreMode === "auto"}
                    min={0}
                    onchange={updateMatchData}
                />
            </div>
        </div>
    {/if}

    <!-- Time Controls Section -->
    {#if matchInfo}
        <div class="time-controls" class:auto-mode={timeMode === "auto"}>
            <div class="time-mode-selector">
                <span class="time-label">Time:</span>
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
            
            <div class="time-display">
                <div class="time-field">
                    <span class="field-label">Period:</span>
                    <NumericInput 
                        bind:value={period}
                        disabled={timeMode === "auto" || $connectionStatus !== "connected"}
                        autoMode={timeMode === "auto"}
                        min={1}
                        max={3}
                        width="60px"
                        onchange={updateMatchData}
                    />
                </div>
                
                <div class="time-field">
                    <span class="field-label">Time:</span>
                    <input 
                        type="text" 
                        class="time-input"
                        class:auto={timeMode === "auto"}
                        class:disabled={timeMode === "period"}
                        bind:value={time}
                        onchange={updateMatchData}
                        disabled={timeMode === "auto" || timeMode === "period" || $connectionStatus !== "connected"}
                        placeholder="MM:SS"
                        pattern="[0-9]{1,2}:[0-9]{2}"
                    />
                </div>
            </div>
        </div>
    {/if}

    <!-- Preview Box -->
    <div
        class="obs-preview-box"
        class:connected={$connectionStatus === "connected"}
        class:collapsed={!obsPreviewExpanded}
    >
        <div class="preview-header">
            <span class="preview-title">Preview</span>
            <div class="preview-actions">
                {#if $connectionStatus === "connected" && obsPreviewExpanded}
                    <button class="copy-url-icon" onclick={copyOverlayUrl} title="Copy Overlay URL">
                        📋
                    </button>
                    <button class="disconnect-icon" onclick={disconnect} title="Disconnect">
                        ❌
                    </button>
                {/if}
                <button 
                    class="expand-icon" 
                    onclick={() => obsPreviewExpanded = !obsPreviewExpanded}
                    title={obsPreviewExpanded ? "Collapse" : "Expand"}
                >
                    {obsPreviewExpanded ? "▼" : "▲"}
                </button>
            </div>
        </div>

        {#if obsPreviewExpanded}
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
        {/if}
    </div>

<style>
    :global(body) {
        background: #121212;
        color: #ffffff;
        margin: 0;
    }

    .admin-container {
        max-width: 1200px;
        margin: 0;
        padding: 70px 20px 20px 40px; /* Add top padding for the top bar, left padding for left-align */
        font-family: Arial, sans-serif;
        min-height: 100vh;
        position: relative;
    }

    h1 {
        text-align: center;
        color: #ffffff;
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
        max-width: 100%;
        padding: 0 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 40px;
    }
    
    .load-match-btn {
        padding: 6px 16px;
        background: #ff5722;
        color: white;
        font-size: 14px;
        font-weight: bold;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.2s;
    }
    
    .load-match-btn:hover {
        background: #ff7043;
    }
    
    .match-info-section {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        gap: 30px;
    }
    
    .match-teams-info {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 16px;
    }
    
    .team-logo {
        width: 32px;
        height: 32px;
        object-fit: contain;
        background: white;
        border-radius: 4px;
        padding: 2px;
    }
    
    .team-name {
        font-weight: bold;
        color: #fff;
    }
    
    .vs {
        color: #888;
        font-size: 14px;
    }
    
    .match-category {
        padding: 2px 8px;
        background: #2a2a2a;
        border-radius: 4px;
        font-size: 12px;
        color: #aaa;
        margin-left: 8px;
    }
    
    .match-details-info {
        display: flex;
        align-items: center;
        gap: 20px;
        font-size: 14px;
        color: #aaa;
    }
    
    .match-date,
    .match-time,
    .match-venue {
        white-space: nowrap;
    }
    
    .change-match-btn {
        background: transparent;
        border: 1px solid #444;
        padding: 4px 8px;
        font-size: 14px;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
        margin-left: 12px;
    }
    
    .change-match-btn:hover {
        background: #2a2a2a;
        border-color: #2196f3;
    }

    /* Popup Styles */
    .popup-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    }
    
    .popup-modal {
        background: #1e1e1e;
        border: 2px solid #333;
        border-radius: 8px;
        min-width: 400px;
        max-width: 500px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
    
    .popup-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid #333;
    }
    
    .popup-header h3 {
        margin: 0;
        color: #fff;
        font-size: 18px;
    }
    
    .popup-close {
        background: transparent;
        border: none;
        color: #888;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;
    }
    
    .popup-close:hover {
        color: #fff;
    }
    
    .popup-content {
        padding: 20px;
    }
    
    .popup-field {
        margin-bottom: 20px;
    }
    
    .popup-field label {
        display: block;
        margin-bottom: 8px;
        color: #aaa;
        font-size: 14px;
    }
    
    .popup-field input {
        width: 100%;
        padding: 10px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 14px;
        box-sizing: border-box;
    }
    
    .popup-field input:focus {
        outline: none;
        border-color: #2196f3;
    }
    
    .popup-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        margin-top: 24px;
    }
    
    .popup-load-btn {
        padding: 10px 20px;
        background: #ff5722;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        transition: background 0.2s;
    }
    
    .popup-load-btn:hover:not(:disabled) {
        background: #ff7043;
    }
    
    .popup-load-btn:disabled {
        background: #555;
        cursor: not-allowed;
        opacity: 0.6;
    }
    
    .popup-cancel-btn {
        padding: 10px 20px;
        background: transparent;
        color: #aaa;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
    }
    
    .popup-cancel-btn:hover {
        background: #2a2a2a;
        color: #fff;
        border-color: #666;
    }

    /* Preview Box */
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
    
    .obs-preview-box.collapsed {
        min-width: 200px;
        padding: 12px;
    }
    
    .obs-preview-box.collapsed .preview-header {
        margin-bottom: 0;
        padding-bottom: 0;
        border-bottom: none;
    }

    .obs-preview-box.connected {
        border-color: #66bb6a;
    }

    .preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #333;
    }
    
    .preview-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    
    .copy-url-icon,
    .disconnect-icon,
    .expand-icon {
        background: transparent;
        border: 1px solid #444;
        padding: 4px 8px;
        font-size: 16px;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
    }
    
    .expand-icon {
        font-size: 12px;
        padding: 4px 6px;
    }
    
    .expand-icon:hover {
        background: #2a2a2a;
        border-color: #2196f3;
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
        max-width: 800px;
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
    
    /* Score Controls */
    .score-controls {
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 16px 20px;
        margin-bottom: 20px;
        max-width: 800px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 30px;
        transition: border-color 0.2s;
    }
    
    .score-controls.auto-mode {
        border-color: #2196f3;
    }
    
    .score-mode-selector {
        display: flex;
        align-items: center;
        gap: 15px;
    }
    
    .score-label {
        font-size: 16px;
        font-weight: bold;
        color: #fff;
    }
    
    .radio-option {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        color: #aaa;
        font-size: 14px;
    }
    
    .radio-option input[type="radio"] {
        width: 16px;
        height: 16px;
        cursor: pointer;
    }
    
    .radio-option:hover {
        color: #fff;
    }
    
    .polling-indicator {
        font-size: 14px;
        animation: spin 1s linear infinite;
        color: #2196f3;
    }
    
    @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    
    .score-display {
        display: flex;
        align-items: center;
        gap: 20px;
    }
    
    
    .team-score-display {
        font-size: 32px;
        font-weight: bold;
        color: #fff;
        min-width: 60px;
        text-align: center;
    }
    
    .team-score-display.auto {
        color: #2196f3;
        border: 1px solid #2196f3;
        border-radius: 4px;
        padding: 4px 8px;
        background: rgba(33, 150, 243, 0.1);
    }
    
    .score-separator {
        font-size: 24px;
        color: #666;
        font-weight: bold;
    }
    
    /* Time Controls */
    .time-controls {
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 16px 20px;
        margin-bottom: 20px;
        max-width: 800px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 30px;
        transition: border-color 0.2s;
    }
    
    .time-controls.auto-mode {
        border-color: #2196f3;
    }
    
    .time-mode-selector {
        display: flex;
        align-items: center;
        gap: 15px;
    }
    
    .time-label {
        font-size: 16px;
        font-weight: bold;
        color: #fff;
    }
    
    .time-display {
        display: flex;
        align-items: center;
        gap: 30px;
    }
    
    .time-field {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    
    .field-label {
        font-size: 14px;
        color: #aaa;
        min-width: 50px;
    }
    
    .time-input {
        width: 80px;
        height: 40px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #2a2a2a;
        color: #fff;
        font-size: 16px;
        font-weight: bold;
        text-align: center;
        padding: 0 8px;
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
</style>
