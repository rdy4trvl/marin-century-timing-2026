// speedModel.js - Gradient-adjusted cycling speed calculations

export class SpeedModel {
    constructor(config = {}) {
        this.uphillFactor = config.uphillFactor ?? 1.0;    // mph reduction per 1% grade uphill
        this.downhillFactor = config.downhillFactor ?? 0.5; // mph increase per 1% negative grade
        this.minSpeed = config.minSpeed ?? 3;               // mph absolute minimum
        this.maxSpeed = config.maxSpeed ?? 30;              // mph absolute maximum (safety)
        this.weatherFactor = config.weatherFactor ?? 0;     // 0 to 0.25 (25% max reduction)
        this.weatherStartHour = config.weatherStartHour ?? 12; // noon default
    }

    /**
     * Calculate adjusted speed for a segment based on grade and time of day.
     * @param {number} baseSpeed - Flat-ground speed in mph
     * @param {number} gradePercent - Segment grade as a percentage (positive = uphill)
     * @param {number} timeOfDay - Current time in decimal hours (e.g., 13.5 = 1:30 PM)
     * @returns {number} Adjusted speed in mph
     */
    getAdjustedSpeed(baseSpeed, gradePercent, timeOfDay) {
        let speed = baseSpeed;

        // Gradient adjustment
        if (gradePercent > 0) {
            // Uphill: reduce speed. Steeper = slower.
            speed = baseSpeed - (gradePercent * this.uphillFactor);
        } else if (gradePercent < 0) {
            // Downhill: increase speed, but less aggressively than the uphill penalty
            speed = baseSpeed + (Math.abs(gradePercent) * this.downhillFactor);
        }

        // Clamp to safe range
        speed = Math.max(this.minSpeed, Math.min(this.maxSpeed, speed));

        // Weather / heat adjustment (afternoon slowdown)
        if (this.weatherFactor > 0 && timeOfDay >= this.weatherStartHour) {
            speed *= (1 - this.weatherFactor);
            speed = Math.max(this.minSpeed, speed);
        }

        return speed;
    }

    /**
     * Calculate time to traverse a segment in hours.
     * @param {number} distanceMiles - Segment distance in miles
     * @param {number} baseSpeed - Flat-ground speed in mph
     * @param {number} gradePercent - Segment grade percentage
     * @param {number} timeOfDay - Current time in decimal hours
     * @returns {number} Time in hours
     */
    getSegmentTime(distanceMiles, baseSpeed, gradePercent, timeOfDay) {
        const speed = this.getAdjustedSpeed(baseSpeed, gradePercent, timeOfDay);
        return distanceMiles / speed;
    }

    /**
     * Get a descriptive label for the speed at a given grade.
     * Useful for UI display.
     */
    describeSpeed(baseSpeed, gradePercent) {
        const adjusted = this.getAdjustedSpeed(baseSpeed, gradePercent, 10); // morning, no weather
        const change = adjusted - baseSpeed;
        const pct = Math.round((change / baseSpeed) * 100);
        if (Math.abs(pct) < 3) return 'normal';
        if (pct < 0) return `${Math.abs(pct)}% slower`;
        return `${pct}% faster`;
    }

    /**
     * Update weather settings.
     */
    setWeather(factor, startHour) {
        this.weatherFactor = Math.max(0, Math.min(0.25, factor));
        this.weatherStartHour = startHour;
    }
}
