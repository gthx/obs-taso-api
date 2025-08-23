<script>
    let {
        value = $bindable(0),
        disabled = false,
        min = 0,
        max = undefined,
        step = 1,
        width = "80px",
        onchange = () => {},
        autoMode = false
    } = $props();

    let inputElement;

    function increment(event) {
        if (disabled) return;
        if (max !== undefined && value >= max) return; // Don't increment if already at max
        const newValue = value + step;
        if (max === undefined || newValue <= max) {
            value = newValue;
            onchange();
        }
        // Blur both the input and the button after incrementing
        if (inputElement) inputElement.blur();
        if (event && event.target) event.target.blur();
    }

    function decrement(event) {
        if (disabled) return;
        if (value <= min) return; // Don't decrement if already at min
        const newValue = value - step;
        if (newValue >= min) {
            value = newValue;
            onchange();
        }
        // Blur both the input and the button after decrementing
        if (inputElement) inputElement.blur();
        if (event && event.target) event.target.blur();
    }

    function handleInputChange() {
        if (disabled) return;
        // Ensure value is within bounds
        if (value < min) value = min;
        if (max !== undefined && value > max) value = max;
        onchange();
        // Blur the input after change
        if (inputElement) inputElement.blur();
    }
</script>

<div class="numeric-input-group">
    <button 
        class="numeric-btn" 
        onclick={decrement}
        disabled={disabled}
        type="button"
    >-</button>
    <input 
        type="number" 
        class="numeric-input"
        class:auto={autoMode}
        bind:value={value}
        bind:this={inputElement}
        onchange={handleInputChange}
        onkeydown={(e) => {
            if (e.key === 'Enter') {
                handleInputChange();
                e.target.blur();
            }
        }}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        style="width: {width};"
    />
    <button 
        class="numeric-btn" 
        onclick={increment}
        disabled={disabled}
        type="button"
    >+</button>
</div>

<style>
    .numeric-input-group {
        display: flex;
        align-items: center;
        gap: 0;
    }
    
    .numeric-btn {
        width: 40px;
        height: 40px;
        border-radius: 0;
        border: 1px solid #444;
        background: #2a2a2a;
        color: #fff;
        font-size: 16px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.2s;
        box-sizing: border-box;
    }
    
    .numeric-btn:first-child {
        border-top-left-radius: 4px;
        border-bottom-left-radius: 4px;
        border-right: none;
    }
    
    .numeric-btn:last-child {
        border-top-right-radius: 4px;
        border-bottom-right-radius: 4px;
        border-left: none;
    }
    
    .numeric-btn:hover:not(:disabled) {
        background: #2196f3;
        border-color: #2196f3;
    }
    
    .numeric-btn:disabled {
        background: #1a1a1a;
        border-color: #333;
        color: #666;
        cursor: not-allowed;
    }
    
    .numeric-input {
        height: 40px;
        border: 1px solid #444;
        border-radius: 0;
        background: #2a2a2a;
        color: #fff;
        font-size: 20px;
        font-weight: bold;
        text-align: center;
        padding: 0;
        box-sizing: border-box;
        -moz-appearance: textfield; /* Firefox: hide spinner */
        transition: all 0.2s;
    }
    
    /* Hide spinner buttons in WebKit browsers */
    .numeric-input::-webkit-outer-spin-button,
    .numeric-input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    
    .numeric-input:focus {
        outline: none;
        border-color: #2196f3;
        background: #333;
    }
    
    .numeric-input:disabled {
        background: #1a1a1a;
        border-color: #333;
        color: #666;
        cursor: not-allowed;
    }
    
    .numeric-input.auto {
        background: rgba(33, 150, 243, 0.1);
        border-color: #2196f3;
        color: #2196f3;
    }
</style>