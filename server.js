require('dotenv').config(); // Load environment variables
const express = require('express');
const admin = require('firebase-admin'); // Firebase Admin SDK

const app = express();
const port = process.env.PORT || 3000;

// ✅ Direct import of the service account JSON file
const serviceAccount = require('./firebase-service-account.json');

// ✅ Initialize Firebase Admin directly (no .env file path used)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // Firestore instance
app.use(express.json());

// --- API KEY Authentication Middleware ---
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!process.env.API_KEY || !apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key.' });
    }
    next();
};

// --- Ingest Sales from Tally ---
app.post('/api/ingest_tally_sales', authenticateApiKey, async (req, res) => {
    const { Sale: salesDataArray } = req.body;

    if (!salesDataArray || !Array.isArray(salesDataArray) || salesDataArray.length === 0) {
        return res.status(400).json({ error: "Invalid data format. Expected {'Sale': [...]}" });
    }

    const processedVouchers = [];
    const errors = [];

    for (const saleData of salesDataArray) {
        const voucherNumber = saleData.VoucherNumber;
        if (!voucherNumber) {
            errors.push(`Missing VoucherNumber. Skipped.`);
            continue;
        }

        try {
            const saleDocRef = db.collection('sales').doc(voucherNumber);
            const existingDoc = await saleDocRef.get();

            if (existingDoc.exists) {
                errors.push(`VoucherNumber "${voucherNumber}" already exists.`);
                continue;
            }

            const saleToStore = { ...saleData };
            delete saleToStore.ItemDetails;
            delete saleToStore.LedgerDetails;

            await saleDocRef.set(saleToStore);

            const itemDetailsBatch = db.batch();
            for (const item of saleData.ItemDetails || []) {
                const newItemRef = saleDocRef.collection('itemDetails').doc();
                itemDetailsBatch.set(newItemRef, item);
            }
            await itemDetailsBatch.commit();

            const ledgerDetailsBatch = db.batch();
            for (const ledger of saleData.LedgerDetails || []) {
                const newLedgerRef = saleDocRef.collection('ledgerDetails').doc();
                ledgerDetailsBatch.set(newLedgerRef, {
                    LedgerName: ledger.LedgerName,
                    LedgerAmount: ledger.LedgerAmount || 0,
                    LedgerValue: ledger.LedgerValue || 0
                });
            }
            await ledgerDetailsBatch.commit();

            processedVouchers.push(voucherNumber);
        } catch (err) {
            errors.push(`Voucher "${voucherNumber}": ${err.message}`);
        }
    }

    return res.status(errors.length > 0 ? 207 : 200).json({
        message: `Processed ${processedVouchers.length} sales${errors.length ? ` with ${errors.length} errors` : ''}.`,
        processed_vouchers: processedVouchers,
        errors
    });
});

// --- Get Sales ---
app.get('/api/get_sales', async (req, res) => {
    try {
        const salesSnapshot = await db.collection('sales').get();
        const sales = [];

        for (const saleDoc of salesSnapshot.docs) {
            const saleData = saleDoc.data();
            saleData.VoucherNumber = saleDoc.id;

            const itemDetailsSnapshot = await saleDoc.ref.collection('itemDetails').get();
            saleData.ItemDetails = itemDetailsSnapshot.docs.map(doc => doc.data());

            const ledgerDetailsSnapshot = await saleDoc.ref.collection('ledgerDetails').get();
            saleData.LedgerDetails = ledgerDetailsSnapshot.docs.map(doc => doc.data());

            sales.push(saleData);
        }

        return res.status(200).json({ Sale: sales });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to retrieve sales data.' });
    }
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Tally API running at http://localhost:${port}`);
});
