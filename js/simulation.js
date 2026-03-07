// simulation.js - Rider slug simulation engine

export class Simulation {
    constructor(speedModel) {
        this.speedModel = speedModel;
    }

    /**
     * Create rider slugs for a route.
     * Each slug = one combination of (start-time-window × speed-tier).
     * @param {Object} routeConfig
     * @returns {Array} Array of slug objects
     */
    createSlugs(routeConfig) {
        const slugs = [];
        const {
            totalRiders,
            noShowRate = 0.10,
            speedTiers = [17, 15, 13.5, 12, 10],
            tierWeights = [0.05, 0.20, 0.50, 0.20, 0.05],
            startTimes = []
        } = routeConfig;

        const effectiveRiders = totalRiders * (1 - noShowRate);
        const tierNames = ['max', 'upper', 'mid', 'lower', 'min'];

        for (const startSlot of startTimes) {
            if (startSlot.percentage <= 0) continue;

            for (let t = 0; t < speedTiers.length; t++) {
                const riderCount = effectiveRiders * startSlot.percentage * tierWeights[t];
                if (riderCount < 0.1) continue; // skip negligible groups

                slugs.push({
                    id: `${startSlot.hour.toFixed(1)}-${tierNames[t]}`,
                    startHour: startSlot.hour,
                    speedTierIndex: t,
                    tierName: tierNames[t],
                    baseSpeed: speedTiers[t],
                    riderCount: riderCount,
                });
            }
        }

        return slugs;
    }

    /**
     * Simulate a single slug through all segments.
     * Returns arrival/departure time and speed at each segment.
     * @param {Object} slug
     * @param {Array} segments - Route segments from GPX parser
     * @param {Array} restStops - Rest stops with dwell times
     * @returns {Array} Per-segment timing results
     */
    simulateSlug(slug, segments, restStops) {
        const results = [];
        let cumulativeTime = slug.startHour; // in decimal hours

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const timeOfDay = cumulativeTime;
            const adjustedSpeed = this.speedModel.getAdjustedSpeed(
                slug.baseSpeed, seg.grade, timeOfDay
            );
            const segmentTime = seg.distance / adjustedSpeed; // hours

            const arrivalTime = cumulativeTime;
            const departureTime = cumulativeTime + segmentTime;

            results.push({
                segmentId: seg.id,
                arrivalTime,
                departureTime,
                adjustedSpeed: Math.round(adjustedSpeed * 10) / 10,
                riderCount: slug.riderCount,
                mile: seg.cumulativeDistance
            });

            cumulativeTime = departureTime;

            // Add rest stop dwell time if this segment has a rest stop
            const restStop = restStops.find(rs => rs.segmentIndex === i);
            if (restStop) {
                const dwellMinutes = restStop.dwellTimes[slug.tierName] || 10;
                const dwellHours = dwellMinutes / 60;
                cumulativeTime += dwellHours;

                // Record rest stop arrival for this slug
                results[results.length - 1].restStopName = restStop.name;
                results[results.length - 1].restStopArrival = arrivalTime + segmentTime;
                results[results.length - 1].restStopDeparture = cumulativeTime;
                results[results.length - 1].dwellMinutes = dwellMinutes;
            }
        }

        // Record finish time
        if (results.length > 0) {
            results[results.length - 1].isFinish = true;
        }

        return results;
    }

    /**
     * Run full simulation for one route.
     */
    runRouteSimulation(routeConfig, segments, restStops) {
        const slugs = this.createSlugs(routeConfig);
        const slugResults = [];

        for (const slug of slugs) {
            const results = this.simulateSlug(slug, segments, restStops);
            slugResults.push({ slug, results });
        }

        return {
            routeName: routeConfig.name,
            totalRiders: routeConfig.totalRiders,
            effectiveRiders: Math.round(routeConfig.totalRiders * (1 - (routeConfig.noShowRate || 0.10))),
            slugCount: slugs.length,
            slugResults
        };
    }

    /**
     * Get the finish time range for a route simulation.
     */
    getFinishTimeRange(simulationResult) {
        let earliest = Infinity;
        let latest = 0;

        for (const { results } of simulationResult.slugResults) {
            const finish = results[results.length - 1];
            if (finish) {
                earliest = Math.min(earliest, finish.departureTime);
                latest = Math.max(latest, finish.departureTime);
            }
        }

        return {
            earliest: earliest === Infinity ? 0 : earliest,
            latest
        };
    }
}
