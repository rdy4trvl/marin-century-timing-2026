// aggregation.js - Cross-route aggregation and rest stop reporting

export class Aggregation {
    constructor(timeResolutionMinutes = 30) {
        this.timeResolution = timeResolutionMinutes / 60; // in hours
        this.startHour = 5;  // 5 AM
        this.endHour = 22;   // 10 PM
    }

    /**
     * Get all time bands for the day.
     */
    getTimeBands() {
        const bands = [];
        for (let h = this.startHour; h < this.endHour; h += this.timeResolution) {
            bands.push({
                startHour: h,
                endHour: h + this.timeResolution,
                label: this.formatTime(h)
            });
        }
        return bands;
    }

    /**
     * Format decimal hours to time string. e.g., 13.5 -> "1:30 PM"
     */
    formatTime(hours) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return `${displayH}:${m.toString().padStart(2, '0')} ${period}`;
    }

    /**
     * Format decimal hours to short time (e.g., "1:30p")
     */
    formatTimeShort(hours) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        const p = h >= 12 ? 'p' : 'a';
        const displayH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return `${displayH}:${m.toString().padStart(2, '0')}${p}`;
    }

    /**
     * Create segment × time-band heatmap for a single route.
     */
    createHeatmap(simulationResult, segments) {
        const timeBands = this.getTimeBands();
        const heatmap = [];

        for (const seg of segments) {
            const row = {
                segmentId: seg.id,
                mile: seg.cumulativeDistance,
                distance: seg.distance,
                grade: seg.grade,
                type: seg.type,
                counts: new Array(timeBands.length).fill(0),
                totalRiders: 0
            };

            for (const { slug, results } of simulationResult.slugResults) {
                const segResult = results.find(r => r.segmentId === seg.id);
                if (!segResult) continue;

                for (let b = 0; b < timeBands.length; b++) {
                    const band = timeBands[b];
                    // Slug occupies this segment during this time band if there's overlap
                    if (segResult.arrivalTime < band.endHour &&
                        segResult.departureTime > band.startHour) {
                        row.counts[b] += segResult.riderCount;
                    }
                }
                row.totalRiders += segResult.riderCount;
            }

            // Round counts
            row.counts = row.counts.map(c => Math.round(c));
            row.totalRiders = Math.round(row.totalRiders);
            heatmap.push(row);
        }

        return { timeBands, heatmap };
    }

    /**
     * Generate rest stop summary for a single route simulation.
     */
    createRestStopSummary(simulationResult, restStops) {
        const timeBands = this.getTimeBands();
        const summaries = [];

        for (const rs of restStops) {
            let firstArrival = Infinity;
            let lastDeparture = 0;
            let totalRiders = 0;
            const bandCounts = new Array(timeBands.length).fill(0);

            for (const { slug, results } of simulationResult.slugResults) {
                const segResult = results.find(r => r.segmentId === rs.segmentIndex);
                if (!segResult) continue;

                // Rest stop timing
                const dwellMinutes = rs.dwellTimes[slug.tierName] || 10;
                const dwellHours = dwellMinutes / 60;
                const arrivalTime = segResult.departureTime; // arrive at rest stop after traversing segment
                const departureTime = arrivalTime + dwellHours;

                firstArrival = Math.min(firstArrival, arrivalTime);
                lastDeparture = Math.max(lastDeparture, departureTime);
                totalRiders += slug.riderCount;

                // Count riders present at rest stop per time band
                // Changed: Only count their arrival so bars sum exactly to Total Riders
                for (let b = 0; b < timeBands.length; b++) {
                    if (arrivalTime >= timeBands[b].startHour && arrivalTime < timeBands[b].endHour) {
                        bandCounts[b] += slug.riderCount;
                        break; // Count once per slug based on arrival
                    }
                }
            }

            if (totalRiders < 1) continue;

            const roundedCounts = bandCounts.map(c => Math.round(c));
            const peakCount = Math.max(...roundedCounts);
            const peakIndex = roundedCounts.indexOf(peakCount);

            summaries.push({
                name: rs.name,
                mile: rs.mile,
                segmentIndex: rs.segmentIndex,
                setupTime: firstArrival - 0.5,
                openTime: firstArrival,
                closeTime: lastDeparture,
                peakBand: timeBands[peakIndex]?.label || '',
                peakCount,
                totalRiders: Math.round(totalRiders),
                bandCounts: roundedCounts,
                timeBands,
                dwellTimes: rs.dwellTimes
            });
        }

        return summaries;
    }

    /**
     * Aggregate rest stop data across all routes.
     * Matches rest stops by name (case-insensitive).
     */
    aggregateRestStops(allRouteData) {
        const byName = {};

        for (const { routeName, summaries } of allRouteData) {
            for (const summary of summaries) {
                const key = summary.name.toLowerCase().trim();

                if (!byName[key]) {
                    byName[key] = {
                        name: summary.name,
                        mile: summary.mile,
                        routes: [],
                        setupTime: Infinity,
                        openTime: Infinity,
                        closeTime: 0,
                        totalRiders: 0,
                        bandCounts: new Array(summary.bandCounts.length).fill(0),
                        timeBands: summary.timeBands
                    };
                }

                const agg = byName[key];
                agg.routes.push(routeName);
                agg.setupTime = Math.min(agg.setupTime, summary.setupTime);
                agg.openTime = Math.min(agg.openTime, summary.openTime);
                agg.closeTime = Math.max(agg.closeTime, summary.closeTime);
                agg.totalRiders += summary.totalRiders;

                for (let i = 0; i < summary.bandCounts.length; i++) {
                    agg.bandCounts[i] += summary.bandCounts[i];
                }
            }
        }

        // Calculate peaks and round
        const aggregated = Object.values(byName).map(agg => {
            agg.bandCounts = agg.bandCounts.map(c => Math.round(c));
            const peakCount = Math.max(...agg.bandCounts);
            const peakIndex = agg.bandCounts.indexOf(peakCount);

            return {
                ...agg,
                peakCount,
                peakBand: agg.timeBands[peakIndex]?.label || '',
                totalRiders: Math.round(agg.totalRiders)
            };
        });

        // Sort by earliest open time
        aggregated.sort((a, b) => a.openTime - b.openTime);
        return aggregated;
    }

    /**
     * Generate a printable rest stop captain report.
     */
    generateCaptainReport(restStopSummary) {
        const { name, routes, setupTime, openTime, closeTime, totalRiders,
            peakBand, peakCount, bandCounts, timeBands } = restStopSummary;

        // Find active hours (bands with riders > 0)
        const activeStart = bandCounts.findIndex(c => c > 0);
        const activeEnd = bandCounts.length - 1 - [...bandCounts].reverse().findIndex(c => c > 0);

        const activeBands = [];
        for (let i = activeStart; i <= activeEnd; i++) {
            activeBands.push({
                time: timeBands[i].label,
                riders: bandCounts[i]
            });
        }

        return {
            name,
            routes: routes.join(', '),
            setup: this.formatTime(setupTime),
            open: this.formatTime(openTime),
            close: this.formatTime(closeTime),
            totalRiders,
            peakTime: peakBand,
            peakRiders: peakCount,
            hourlyBreakdown: activeBands
        };
    }

    /**
     * Create shared road segment analysis across routes.
     * Identifies segments where multiple routes overlap based on GPS proximity.
     */
    findSharedSegments(allRouteParsed, proximityThresholdMiles = 0.03) {
        const sharedGroups = [];
        const routeNames = Object.keys(allRouteParsed);

        // Compare each pair of routes
        for (let r1 = 0; r1 < routeNames.length; r1++) {
            for (let r2 = r1 + 1; r2 < routeNames.length; r2++) {
                const name1 = routeNames[r1];
                const name2 = routeNames[r2];
                const segs1 = allRouteParsed[name1].segments;
                const segs2 = allRouteParsed[name2].segments;

                for (const s1 of segs1) {
                    for (const s2 of segs2) {
                        const d = this.haversineDistance(
                            s1.startLat, s1.startLon,
                            s2.startLat, s2.startLon
                        );

                        if (d < proximityThresholdMiles) {
                            sharedGroups.push({
                                routes: [name1, name2],
                                segments: [
                                    { route: name1, segmentId: s1.id, mile: s1.cumulativeDistance },
                                    { route: name2, segmentId: s2.id, mile: s2.cumulativeDistance }
                                ],
                                proximityFeet: Math.round(d * 5280)
                            });
                        }
                    }
                }
            }
        }

        return sharedGroups;
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 3959;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
}
