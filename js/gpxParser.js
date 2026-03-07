// gpxParser.js - Parse GPX files and extract route segments with elevation data

export class GPXParser {
    constructor(options = {}) {
        this.minSegmentLength = options.minSegmentLength || 0.15; // miles
        this.gradeThreshold = options.gradeThreshold || 1.5; // % grade change triggers new segment
    }

    async parseFile(file) {
        const text = await file.text();
        return this.parseXML(text);
    }

    parseXML(xmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, 'text/xml');

        const parserError = doc.querySelector('parsererror');
        if (parserError) {
            throw new Error('Invalid GPX file: ' + parserError.textContent);
        }

        // Extract trackpoints
        const trackpoints = this.extractTrackpoints(doc);
        if (trackpoints.length < 2) {
            throw new Error('GPX file must contain at least 2 trackpoints');
        }

        // Extract all waypoints
        const allWaypoints = this.extractWaypoints(doc);

        // Separate meaningful stops from directional cues
        const { meaningfulStops, directionalWaypoints } = this.filterWaypoints(allWaypoints);

        // Create segments from trackpoints
        const segments = this.createSegments(trackpoints);

        // Match meaningful waypoints to nearest segments (these become rest stops)
        const restStops = this.matchWaypointsToSegments(meaningfulStops, segments);

        // Also match ALL waypoints to segments for tooltip display
        const allWaypointsBySegment = this.mapAllWaypointsToSegments(allWaypoints, segments);

        // Route statistics
        const totalDistance = segments.length > 0
            ? segments[segments.length - 1].cumulativeDistance
            : 0;
        const totalClimbing = segments.reduce(
            (sum, s) => sum + Math.max(0, s.elevationGain), 0
        );
        const totalDescending = segments.reduce(
            (sum, s) => sum + Math.min(0, s.elevationGain), 0
        );

        return {
            trackpoints,
            segments,
            restStops,
            waypoints: allWaypoints,
            waypointsBySegment: allWaypointsBySegment,
            stats: {
                totalDistance: Math.round(totalDistance * 100) / 100,
                totalClimbing: Math.round(totalClimbing * 3.281), // meters to feet
                totalDescending: Math.round(Math.abs(totalDescending) * 3.281),
                segmentCount: segments.length,
                waypointCount: allWaypoints.length,
                restStopCount: meaningfulStops.length,
            }
        };
    }

    extractTrackpoints(doc) {
        const trkpts = doc.querySelectorAll('trkpt');
        const points = [];

        for (const pt of trkpts) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            const eleNode = pt.querySelector('ele');
            const ele = eleNode ? parseFloat(eleNode.textContent) : 0;

            if (!isNaN(lat) && !isNaN(lon)) {
                points.push({ lat, lon, ele: isNaN(ele) ? 0 : ele });
            }
        }

        // Smooth elevation data to reduce GPS noise
        return this.smoothElevation(points);
    }

    smoothElevation(points, windowSize = 5) {
        if (points.length < windowSize) return points;

        const smoothed = points.map((p, i) => {
            const half = Math.floor(windowSize / 2);
            const start = Math.max(0, i - half);
            const end = Math.min(points.length - 1, i + half);
            let sum = 0;
            let count = 0;
            for (let j = start; j <= end; j++) {
                sum += points[j].ele;
                count++;
            }
            return { ...p, ele: sum / count };
        });

        return smoothed;
    }

    extractWaypoints(doc) {
        const wpts = doc.querySelectorAll('wpt');
        const waypoints = [];

        for (const wpt of wpts) {
            const lat = parseFloat(wpt.getAttribute('lat'));
            const lon = parseFloat(wpt.getAttribute('lon'));
            const nameNode = wpt.querySelector('name');
            const descNode = wpt.querySelector('desc');
            const name = nameNode ? nameNode.textContent.trim() : `Waypoint ${waypoints.length + 1}`;
            const desc = descNode ? descNode.textContent.trim() : '';

            if (!isNaN(lat) && !isNaN(lon)) {
                waypoints.push({ lat, lon, name, description: desc });
            }
        }

        return waypoints;
    }

    /**
     * Filter waypoints into meaningful stops vs directional cues.
     * Only waypoints matching key words become rest stops.
     */
    filterWaypoints(waypoints) {
        // Keywords that indicate a meaningful stop (case-insensitive)
        const stopKeywords = [
            'rest stop', 'rest', 'rs', 'water stop', 'water',
            'summit', 'peak', 'school', 'elementary',
            'finish', 'course end', 'congratulations', 'start',
            'lunch', 'food', 'aid station', 'checkpoint', 'check point',
            'park', 'civic center'
        ];

        // Keywords that indicate directional cues to EXCLUDE
        const directionalKeywords = [
            'slight left', 'slight right', 'sharp left', 'sharp right',
            'turn left', 'turn right', 'straight', 'continue',
            'bear left', 'bear right', 'keep left', 'keep right',
            'merge', 'fork', 'u-turn', 'uturn', 'roundabout'
        ];

        const meaningfulStops = [];
        const directionalWaypoints = [];

        for (const wp of waypoints) {
            const nameLower = wp.name.toLowerCase();

            // Check if it's a directional cue first
            const isDirectional = directionalKeywords.some(kw => nameLower.includes(kw));
            if (isDirectional) {
                directionalWaypoints.push(wp);
                continue;
            }

            // Check if it matches a meaningful stop keyword
            const isMeaningful = stopKeywords.some(kw => nameLower.includes(kw));
            if (isMeaningful) {
                meaningfulStops.push(wp);
            } else {
                // Unknown — treat as directional/skip by default
                directionalWaypoints.push(wp);
            }
        }

        return { meaningfulStops, directionalWaypoints };
    }

    /**
     * Map ALL waypoints (including directional) to their nearest segment.
     * Returns a Map: segmentId -> [waypoint names]
     * Used for hover tooltips to show what's at/near each segment.
     */
    mapAllWaypointsToSegments(waypoints, segments) {
        const bySegment = {};

        for (const wp of waypoints) {
            let closestSegIndex = 0;
            let closestDist = Infinity;

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const dStart = this.haversineDistance(wp.lat, wp.lon, seg.startLat, seg.startLon);
                const dEnd = this.haversineDistance(wp.lat, wp.lon, seg.endLat, seg.endLon);
                const d = Math.min(dStart, dEnd);
                if (d < closestDist) {
                    closestDist = d;
                    closestSegIndex = i;
                }
            }

            if (!bySegment[closestSegIndex]) {
                bySegment[closestSegIndex] = [];
            }
            bySegment[closestSegIndex].push(wp.name);
        }

        return bySegment;
    }

    createSegments(trackpoints) {
        if (trackpoints.length < 2) return [];

        // First pass: calculate point-to-point data
        const pointData = [];
        for (let i = 1; i < trackpoints.length; i++) {
            const prev = trackpoints[i - 1];
            const curr = trackpoints[i];
            const dist = this.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
            const eleDiff = curr.ele - prev.ele; // meters
            // Grade: elevation change / horizontal distance, as percentage
            const horizontalDist = dist * 1609.34; // convert miles to meters
            const grade = horizontalDist > 1 ? (eleDiff / horizontalDist) * 100 : 0;

            pointData.push({
                index: i,
                distance: dist,
                eleDiff,
                grade: Math.max(-25, Math.min(25, grade)), // clamp extreme values
                point: curr,
                prevPoint: prev
            });
        }

        // Second pass: group into segments by grade similarity
        const rawSegments = [];
        let segDistance = 0;
        let segEleGain = 0;
        let segStartIndex = 0;
        let prevCategory = this.gradeCategory(pointData[0].grade);

        for (let i = 0; i < pointData.length; i++) {
            const pd = pointData[i];
            const category = this.gradeCategory(pd.grade);

            // Start new segment when grade category changes AND current segment is long enough
            if (category !== prevCategory && segDistance >= this.minSegmentLength) {
                const startPt = trackpoints[segStartIndex];
                const endPt = trackpoints[pointData[i - 1].index];

                rawSegments.push({
                    distance: segDistance,
                    elevationGain: segEleGain,
                    grade: segDistance > 0
                        ? (segEleGain / (segDistance * 1609.34)) * 100
                        : 0,
                    startElevation: startPt.ele,
                    endElevation: endPt.ele,
                    startLat: startPt.lat,
                    startLon: startPt.lon,
                    endLat: endPt.lat,
                    endLon: endPt.lon,
                });

                segStartIndex = pointData[i - 1].index;
                segDistance = 0;
                segEleGain = 0;
            }

            segDistance += pd.distance;
            segEleGain += pd.eleDiff;
            prevCategory = category;
        }

        // Add final segment
        if (segDistance > 0.01) {
            const startPt = trackpoints[segStartIndex];
            const endPt = trackpoints[trackpoints.length - 1];
            rawSegments.push({
                distance: segDistance,
                elevationGain: segEleGain,
                grade: segDistance > 0
                    ? (segEleGain / (segDistance * 1609.34)) * 100
                    : 0,
                startElevation: startPt.ele,
                endElevation: endPt.ele,
                startLat: startPt.lat,
                startLon: startPt.lon,
                endLat: endPt.lat,
                endLon: endPt.lon,
            });
        }

        // Merge small segments and assign IDs
        return this.finalizeSegments(rawSegments);
    }

    finalizeSegments(rawSegments) {
        if (rawSegments.length === 0) return [];

        // Merge segments that are too small
        const merged = [];
        let current = { ...rawSegments[0] };

        for (let i = 1; i < rawSegments.length; i++) {
            if (current.distance < this.minSegmentLength) {
                // Merge into next
                current.distance += rawSegments[i].distance;
                current.elevationGain += rawSegments[i].elevationGain;
                current.endElevation = rawSegments[i].endElevation;
                current.endLat = rawSegments[i].endLat;
                current.endLon = rawSegments[i].endLon;
                current.grade = current.distance > 0
                    ? (current.elevationGain / (current.distance * 1609.34)) * 100
                    : 0;
            } else {
                merged.push(current);
                current = { ...rawSegments[i] };
            }
        }
        merged.push(current);

        // Assign IDs, cumulative distance, and type
        let cumDist = 0;
        for (let i = 0; i < merged.length; i++) {
            merged[i].id = i;
            cumDist += merged[i].distance;
            merged[i].cumulativeDistance = Math.round(cumDist * 100) / 100;
            merged[i].distance = Math.round(merged[i].distance * 1000) / 1000;
            merged[i].grade = Math.round(merged[i].grade * 10) / 10;
            merged[i].type = this.segmentType(merged[i].grade);
            merged[i].elevationGain = Math.round(merged[i].elevationGain * 100) / 100;
        }

        return merged;
    }

    gradeCategory(grade) {
        if (grade > this.gradeThreshold) return 'climb';
        if (grade < -this.gradeThreshold) return 'descent';
        return 'flat';
    }

    segmentType(grade) {
        if (grade > 1) return 'climb';
        if (grade < -1) return 'descent';
        return 'flat';
    }

    matchWaypointsToSegments(waypoints, segments) {
        const restStops = [];

        for (const wp of waypoints) {
            let closestSegIndex = 0;
            let closestDist = Infinity;

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                // Check distance to segment start
                const dStart = this.haversineDistance(wp.lat, wp.lon, seg.startLat, seg.startLon);
                // Check distance to segment end
                const dEnd = this.haversineDistance(wp.lat, wp.lon, seg.endLat, seg.endLon);
                const d = Math.min(dStart, dEnd);

                if (d < closestDist) {
                    closestDist = d;
                    closestSegIndex = i;
                }
            }

            restStops.push({
                name: wp.name,
                description: wp.description || '',
                segmentIndex: closestSegIndex,
                mile: segments[closestSegIndex]?.cumulativeDistance || 0,
                lat: wp.lat,
                lon: wp.lon,
                distanceFromRoute: Math.round(closestDist * 5280), // feet
                dwellTimes: { max: 5, upper: 7, mid: 10, lower: 12, min: 12 }
            });
        }

        return restStops;
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 3959; // Earth radius in miles
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    toRad(deg) {
        return deg * Math.PI / 180;
    }
}
