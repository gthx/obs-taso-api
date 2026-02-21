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
    let torneopalEnabled = $derived(torneopalApiKey && matchId);

    let isConnecting = $state(false);

    // Score control state
    let scoreMode = $state("auto"); // "auto" or "manual"
    let apiScores = $state(null);

    // Time control state
    let timeMode = $state("auto"); // "auto", "manual", or "period"

    // Global timer state
    let globalTimerActive = $state(false);

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
        timeMode = mode;
        localStorage.setItem("time-mode", mode);
        updateMatchData();
    }

    async function fetchCurrentScore() {
        if (!torneopalEnabled) {
            return;
        }

        try {
            const result = await torneopalApi.getScore(matchId);
            if (result && result.score) {
                apiScores = result.score;

                if (scoreMode === "auto") {
                    if (
                        result.score.live_A !== "" &&
                        result.score.live_A !== null &&
                        result.score.live_A !== undefined
                    ) {
                        const newHomeScore = parseInt(result.score.live_A);
                        if (!isNaN(newHomeScore)) {
                            homeTeamScore = newHomeScore;
                        }
                    }

                    if (
                        result.score.live_B !== "" &&
                        result.score.live_B !== null &&
                        result.score.live_B !== undefined
                    ) {
                        const newAwayScore = parseInt(result.score.live_B);
                        if (!isNaN(newAwayScore)) {
                            awayTeamScore = newAwayScore;
                        }
                    }

                    if (timeMode === "auto") {
                        if (
                            result.score.live_period &&
                            result.score.live_period !== "-1" &&
                            result.score.live_period !== ""
                        ) {
                            const newPeriod = parseInt(
                                result.score.live_period,
                            );
                            if (!isNaN(newPeriod) && newPeriod > 0) {
                                period = newPeriod;
                            }
                        }

                        if (
                            result.score.live_time_mmss &&
                            result.score.live_time_mmss !== "" &&
                            result.score.live_time_mmss !== "00:00"
                        ) {
                            time = result.score.live_time_mmss;
                        }
                    }

                    await updateMatchData();
                }
            }
        } catch (error) {
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
        if (!matchId || !torneopalApiKey) {
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

        if (timeMode === "manual" && $connectionStatus === "connected") {
            const now = Date.now();
            if (now - lastKeyPress < keyDebounceDelay) {
                return;
            }

            if (event.code === "ArrowUp") {
                event.preventDefault();
                lastKeyPress = now;
                obsWebSocket.sendClockControl("clock_adjust", { delta: 1 });
            } else if (event.code === "ArrowDown") {
                event.preventDefault();
                lastKeyPress = now;
                obsWebSocket.sendClockControl("clock_adjust", { delta: -1 });
            }
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
                    title={globalTimerActive
                        ? "Pause (Spacebar)"
                        : "Play (Spacebar)"}
                >
                    {globalTimerActive ? "⏸" : "▶"}
                </button>

                <span class="timer-status">
                    {globalTimerActive ? "Running" : "Paused"}
                </span>
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

        <!-- Row 4: Shootout (only in period 5 / RL) -->
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
