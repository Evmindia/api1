require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const admin = require('firebase-admin'); // Import Firebase Admin SDK
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- Firebase Admin SDK Initialization ---
// Make sure 'GOOGLE_APPLICATION_CREDENTIALS' environment variable is set
// or provide the service account key directly as an object.
// We are using the file path from .env for simplicity.
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
    console.error('Error: GOOGLE_APPLICATION_CREDENTIALS not set or service account file not found.');
    console.error('Please ensure the .env file has GOOGLE_APPLICATION_CREDENTIALS pointing to your Firebase service account JSON, and the file exists.');
    process.exit(1); // Exit if Firebase credentials are not found
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // Get a Firestore instance

// Middleware to parse JSON request bodies
app.use(express.json());

// Middleware for API Key authentication (implement this carefully!)
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!process.env.API_KEY || !apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key.' });
    }
    next();
};

// --- API Endpoints ---

/**
 * POST /api/ingest_tally_sales
 * Endpoint to receive sales data from Tally.
 * Requires X-API-Key header for authentication.
 * Expected data format: {"Sale": [{...}]}
 */
app.post('/api/ingest_tally_sales', async (req, res) => {
    const { Sale: salesDataArray } = req.body;

    if (!salesDataArray || !Array.isArray(salesDataArray) || salesDataArray.length === 0) {
        return res.status(400).json({ error: "Invalid data format. Expected {'Sale': [...]}" });
    }

    const processedVouchers = [];
    const errors = [];

    for (const saleData of salesDataArray) {
        // Use VoucherNumber as the document ID for easy retrieval and checking duplicates
        const voucherNumber = saleData.VoucherNumber;

        if (!voucherNumber) {
            errors.push(`Sale record is missing "VoucherNumber". Skipping.`);
            continue;
        }

        try {
            const saleDocRef = db.collection('sales').doc(voucherNumber);

            // Check if a sale with this VoucherNumber already exists
            const existingDoc = await saleDocRef.get();

            if (existingDoc.exists) {
                errors.push(`Sale with VoucherNumber "${voucherNumber}" already exists. Skipping.`);
                continue; // Skip to next sale in the loop
            }

            // Prepare data for Firestore document
            const saleToStore = { ...saleData }; // Copy all top-level fields
            delete saleToStore.ItemDetails; // Remove nested arrays as they'll be sub-collections
            delete saleToStore.LedgerDetails;

            // 1. Add/Set the main sales document
            await saleDocRef.set(saleToStore); // This will create a new document with VoucherNumber as ID

            // 2. Add ItemDetails as sub-collection documents
            const itemDetailsBatch = db.batch();
            for (const item of saleData.ItemDetails || []) {
                // Firestore auto-generates IDs for documents added to a collection
                const newItemRef = saleDocRef.collection('itemDetails').doc();
                itemDetailsBatch.set(newItemRef, item);
            }
            await itemDetailsBatch.commit();

            // 3. Add LedgerDetails as sub-collection documents
            const ledgerDetailsBatch = db.batch();
            for (const ledger of saleData.LedgerDetails || []) {
                const newLedgerRef = saleDocRef.collection('ledgerDetails').doc();
                // Ensure LedgerAmount and LedgerValue are numbers, default to 0 if missing
                ledgerDetailsBatch.set(newLedgerRef, {
                    LedgerName: ledger.LedgerName,
                    LedgerAmount: ledger.LedgerAmount || 0,
                    LedgerValue: ledger.LedgerValue || 0
                });
            }
            await ledgerDetailsBatch.commit();

            processedVouchers.push(voucherNumber);

        } catch (err) {
            console.error(`Error processing VoucherNumber "${voucherNumber}":`, err.message);
            errors.push(`Error processing VoucherNumber "${voucherNumber}": ${err.message}`);
        }
    }

    if (errors.length > 0) {
        return res.status(207).json({
            message: `Successfully processed ${processedVouchers.length} sales with errors for ${errors.length} sales.`,
            processed_vouchers: processedVouchers,
            errors: errors
        });
    } else {
        return res.status(200).json({ message: `Successfully ingested ${processedVouchers.length} sales records.` });
    }
});

/**
 * GET /api/get_sales
 * Endpoint for your website to retrieve all sales data.
 */
app.get('/api/get_sales', async (req, res) => {
    try {
        const salesSnapshot = await db.collection('sales').get();
        const sales = [];

        for (const saleDoc of salesSnapshot.docs) {
            const saleData = saleDoc.data();
            // Optionally add the document ID (VoucherNumber) if needed in the response
            saleData.VoucherNumber = saleDoc.id; // Ensure VoucherNumber is part of the returned data

            // Fetch ItemDetails sub-collection
            const itemDetailsSnapshot = await saleDoc.ref.collection('itemDetails').get();
            saleData.ItemDetails = itemDetailsSnapshot.docs.map(doc => doc.data());

            // Fetch LedgerDetails sub-collection
            const ledgerDetailsSnapshot = await saleDoc.ref.collection('ledgerDetails').get();
            saleData.LedgerDetails = ledgerDetailsSnapshot.docs.map(doc => doc.data());

            sales.push(saleData);
        }

        // Ensure the response matches the "Sale": [...] format requested by user
        return res.status(200).json({ Sale: sales });

    } catch (err) {
        console.error('Error fetching sales data from Firestore:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve sales data.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Tally API listening at http://localhost:${port}`);
});