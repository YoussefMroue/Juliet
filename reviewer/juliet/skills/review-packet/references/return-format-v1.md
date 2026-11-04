# Findings file
Return JSON in one code block for Lynn to save as a UTF-8 .json file and import locally. Use exactly these top-level keys. Substitute the actual packet values for all angle-bracket placeholders.

    {
      "format": "juliet.findings.v1",
      "reviewerRelease": "0.1.0",
      "proposalId": "<copy from packet>",
      "roundId": "<copy from packet>",
      "packetId": "<copy from packet>",
      "reportId": "<copy from packet>",
      "digest": "<copy from packet>",
      "coverage": { "reviewed": [], "unreviewed": [] },
      "findings": []
    }

Put each supplied item ID in exactly one coverage list. Identify unreadable or withheld material in a coverage_gap finding. Sections outside the supplied excerpts have no item ID; describe their absence in the summary or a coverage_gap and never invent an item. Empty findings are appropriate for a clean case only when the stated coverage supports the checks.

Each finding contains only type, message, evidence and guidance. Use a message of 1–1000 characters and no more than 30 findings. Each citation is an object with itemId and quote. Copy 1–300 characters exactly from that reviewed item's text. Use at most six citations in each evidence or guidance list. Use only items classified as Opportunity guidance for the guidance list.

An objective_error needs proposal evidence and either governing guidance or two distinct corroborating excerpts. Use two supporting excerpts for reproducible cross-document numerical or factual discrepancies. If an arithmetic concern has only one excerpt and lacks governing guidance, return a question and request independent verification. A suggestion requires proposal evidence and states a judgment separately. Questions and coverage gaps may have no citations where the evidence itself is missing. Quote only what is needed for Lynn to locate and verify the finding. Never fill an absent source with a plausible quotation.
