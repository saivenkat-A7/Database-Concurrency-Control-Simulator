const express = require('express');
const db = require('./db');

const router = express.Router();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: POST /api/products/reset
router.post('/products/reset', async (req, res) => {
    try {
        await db.query(`
      UPDATE products SET stock = 100, version = 1 WHERE name = 'Super Widget';
    `);
        await db.query(`
      UPDATE products SET stock = 50, version = 1 WHERE name = 'Mega Gadget';
    `);
        await db.query('TRUNCATE TABLE orders;');
        res.status(200).json({ message: 'Product inventory reset successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper: GET /api/products/:id
router.get('/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('SELECT * FROM products WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper: GET /api/orders/stats
router.get('/orders/stats', async (req, res) => {
    try {
        const result = await db.query(`
      SELECT
        COUNT(*) as "totalOrders",
        COUNT(*) FILTER (WHERE status = 'SUCCESS') as "successfulOrders",
        COUNT(*) FILTER (WHERE status = 'FAILED_OUT_OF_STOCK') as "failedOutOfStock",
        COUNT(*) FILTER (WHERE status = 'FAILED_CONFLICT') as "failedConflict"
      FROM orders
    `);
        const stats = result.rows[0];
        res.status(200).json({
            totalOrders: parseInt(stats.totalOrders),
            successfulOrders: parseInt(stats.successfulOrders),
            failedOutOfStock: parseInt(stats.failedOutOfStock),
            failedConflict: parseInt(stats.failedConflict)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Option 1: Pessimistic Locking
router.post('/orders/pessimistic', async (req, res) => {
    const { productId, quantity, userId } = req.body;

    if (!productId || !quantity || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // Acquire an exclusive lock on the row using SELECT ... FOR UPDATE
        const productRes = await client.query(
            'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
            [productId]
        );

        if (productRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Product not found' });
        }

        const currentStock = productRes.rows[0].stock;

        if (currentStock < quantity) {
            // Record failure due to out of stock
            await client.query(
                'INSERT INTO orders (product_id, quantity_ordered, user_id, status) VALUES ($1, $2, $3, $4)',
                [productId, quantity, userId, 'FAILED_OUT_OF_STOCK']
            );
            await client.query('COMMIT');
            return res.status(400).json({ error: 'Insufficient stock' });
        }

        // Process valid order
        const remainingStock = currentStock - quantity;

        // Update product stock
        await client.query(
            'UPDATE products SET stock = $1 WHERE id = $2',
            [remainingStock, productId]
        );

        // Insert order history
        const orderRes = await client.query(
            'INSERT INTO orders (product_id, quantity_ordered, user_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
            [productId, quantity, userId, 'SUCCESS']
        );

        await client.query('COMMIT');

        return res.status(201).json({
            orderId: orderRes.rows[0].id,
            productId,
            quantityOrdered: quantity,
            stockRemaining: remainingStock
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Transaction Error (Pessimistic):', err);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Option 2: Optimistic Locking
router.post('/orders/optimistic', async (req, res) => {
    const { productId, quantity, userId } = req.body;

    if (!productId || !quantity || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
        const client = await db.getClient();

        try {
            await client.query('BEGIN');

            // 1. Read the record normally (no locking)
            const productRes = await client.query(
                'SELECT stock, version FROM products WHERE id = $1',
                [productId]
            );

            if (productRes.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: 'Product not found' });
            }

            const { stock: currentStock, version: currentVersion } = productRes.rows[0];

            // 2. Out of stock check
            if (currentStock < quantity) {
                await client.query(
                    'INSERT INTO orders (product_id, quantity_ordered, user_id, status) VALUES ($1, $2, $3, $4)',
                    [productId, quantity, userId, 'FAILED_OUT_OF_STOCK']
                );
                await client.query('COMMIT');
                client.release();
                return res.status(400).json({ error: 'Insufficient stock' });
            }

            const remainingStock = currentStock - quantity;
            const newVersion = currentVersion + 1;

            // 3. Attempt update WITH version check
            const updateRes = await client.query(
                'UPDATE products SET stock = $1, version = $2 WHERE id = $3 AND version = $4',
                [remainingStock, newVersion, productId, currentVersion]
            );

            // 4. Verify update success
            if (updateRes.rowCount === 0) {
                // Version mismatch, conflict occurred
                await client.query('ROLLBACK');
                client.release();

                attempt++;
                if (attempt < MAX_RETRIES) {
                    console.warn(`[Optimistic] Conflict on attempt ${attempt}. Retrying...`);
                    // Exponential backoff
                    const backoffDelay = 50 * Math.pow(2, attempt - 1);
                    await delay(backoffDelay);
                    continue; // Retry the transaction
                } else {
                    // Exhausted retries
                    console.error(`[Optimistic] Exhausted retries. Failing request.`);

                    // Log failure
                    const logClient = await db.getClient();
                    try {
                        await logClient.query(
                            'INSERT INTO orders (product_id, quantity_ordered, user_id, status) VALUES ($1, $2, $3, $4)',
                            [productId, quantity, userId, 'FAILED_CONFLICT']
                        );
                    } finally {
                        logClient.release();
                    }

                    return res.status(409).json({
                        error: 'Failed to place order due to concurrent modification. Please try again.'
                    });
                }
            }

            // Success branch
            const orderRes = await client.query(
                'INSERT INTO orders (product_id, quantity_ordered, user_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
                [productId, quantity, userId, 'SUCCESS']
            );

            await client.query('COMMIT');
            client.release();

            return res.status(201).json({
                orderId: orderRes.rows[0].id,
                productId,
                quantityOrdered: quantity,
                stockRemaining: remainingStock,
                newVersion
            });

        } catch (err) {
            await client.query('ROLLBACK');
            client.release();
            console.error('Transaction Error (Optimistic):', err);
            // Wait before retrying
            attempt++;
            if (attempt < MAX_RETRIES) {
                const backoffDelay = 50 * Math.pow(2, attempt - 1);
                await delay(backoffDelay);
                continue;
            }
            return res.status(500).json({ error: 'Internal server error' });
        }
    }
});

module.exports = router;
