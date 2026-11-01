require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

// เชื่อมต่อ Neon PostgreSQL
const sql = neon(process.env.DATABASE_URL);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// 🟢 สร้างโครงสร้างตารางใน Neon DB อัตโนมัติ
// -----------------------------------------------------------------------------
async function initDatabase() {
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                house_no VARCHAR(50) UNIQUE NOT NULL,
                tenant_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20),
                room_rent NUMERIC(10, 2) DEFAULT 0,
                status VARCHAR(20) DEFAULT 'รอชำระ',
                bill_date DATE,
                due_date DATE,
                fine_text VARCHAR(100),
                fine_rate NUMERIC(10, 2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS payment_methods (
                id SERIAL PRIMARY KEY,
                type VARCHAR(20) NOT NULL,
                bank_name VARCHAR(100),
                account_no VARCHAR(50) NOT NULL,
                account_name VARCHAR(100) NOT NULL,
                is_active BOOLEAN DEFAULT FALSE
            );
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS bills (
                id SERIAL PRIMARY KEY,
                house_no VARCHAR(50) NOT NULL,
                tenant_name VARCHAR(100),
                grand_total NUMERIC(10, 2),
                message_text TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        console.log('✅ Neon Database Connected & Initialized Successfully!');
    } catch (error) {
        console.error('❌ Failed to initialize Neon Database:', error);
    }
}
initDatabase();

// -----------------------------------------------------------------------------
// 🟢 API ออกบิลประจำเดือน
// -----------------------------------------------------------------------------
app.post('/api/generate-bill', async (req, res) => {
    try {
        const data = req.body;
        if (!data.houseNo || isNaN(data.elecAmount)) {
            return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
        }

        const roomRent = Number(data.roomRent) || 0;
        const elecAmount = Number(data.elecAmount) || 0;
        const waterRent = Number(data.waterRent) || 0;
        let grandTotal = roomRent + elecAmount + waterRent;

        let otherText = '';
        if (data.otherFees && data.otherFees.length > 0) {
            data.otherFees.forEach(fee => {
                otherText += `\n📌 ${fee.name}: ${Number(fee.amount).toLocaleString()} บาท`;
                grandTotal += Number(fee.amount);
            });
        }

        let formattedThaiDate = 'ระบุวันที่';
        let rawDueDate = null;
        let fineRateNum = 0;

        if (data.fine && data.fine.dueDate) {
            rawDueDate = data.fine.dueDate; // รูปแบบ YYYY-MM-DD
            const parts = rawDueDate.split('-');
            if (parts.length === 3) {
                const day = parseInt(parts[2], 10);
                const monthNames = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
                const monthName = monthNames[parseInt(parts[1], 10) - 1] || '';
                const thaiYear = parseInt(parts[0], 10) + 543;
                formattedThaiDate = `${day} ${monthName} ${thaiYear}`;
            }
        }

        if (data.fine && data.fine.fineText) {
            const matches = data.fine.fineText.match(/(\d+)/);
            if (matches) fineRateNum = parseFloat(matches[1]);
        }

        let fineTextSection = '';
        if (data.fine) {
            fineTextSection = `\n--------------------------------\n⚠️ กำหนดชำระภายใน: ${formattedThaiDate}\n⏰ หากชำระเกินกำหนด มีค่าปรับ: ${data.fine.fineText || '-'}`;
        }

        const activePayment = await sql`SELECT * FROM payment_methods WHERE is_active = TRUE LIMIT 1;`;
        let paymentText = '';
        if (activePayment.length > 0) {
            const p = activePayment[0];
            if (p.type === 'bank') {
                paymentText = `\n--------------------------------\n💳 ช่องทางชำระเงิน:\nธนาคาร${p.bank_name}\nเลขบัญชี: ${p.account_no}\nชื่อบัญชี: ${p.account_name}`;
            } else {
                paymentText = `\n--------------------------------\n📱 ช่องทางชำระเงิน:\nพร้อมเพย์ (PromptPay)\nหมายเลข: ${p.account_no}\nชื่อบัญชี: ${p.account_name}`;
            }
        }

        const messageText = 
`🧾 แจ้งยอดค่าใช้จ่ายประจำเดือน (บ้านเลขที่ ${data.houseNo})
--------------------------------
👤 ผู้เช่า: ${data.tenantName || 'ผู้เช่า'}
🏠 ค่าเช่า: ${roomRent.toLocaleString()} บาท
⚡️ ค่าไฟฟ้า: ${elecAmount.toLocaleString()} บาท
💧 ค่าน้ำประปา: ${waterRent.toLocaleString()} บาท${otherText}
--------------------------------
💰 ยอดรวมทั้งสิ้น: ${grandTotal.toLocaleString()} บาท${fineTextSection}${paymentText}`;

        // บันทึกประวัติบิล
        await sql`
            INSERT INTO bills (house_no, tenant_name, grand_total, message_text)
            VALUES (${data.houseNo}, ${data.tenantName || ''}, ${grandTotal}, ${messageText});
        `;

        // อัปเดตข้อมูลในตารางผู้เช่า
        const todayStr = new Date().toISOString().split('T')[0];
        await sql`
            UPDATE tenants 
            SET bill_date = ${todayStr}, 
                due_date = ${rawDueDate || null}, 
                fine_text = ${data.fine ? data.fine.fineText : null}, 
                fine_rate = ${fineRateNum},
                status = 'ค้างชำระ'
            WHERE house_no = ${data.houseNo};
        `;

        res.json({ success: true, grandTotal, messageText });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// -----------------------------------------------------------------------------
// 🟢 API จัดการผู้เช่า (Tenants)
// -----------------------------------------------------------------------------
app.get('/api/tenants', async (req, res) => {
    try {
        const tenants = await sql`SELECT * FROM tenants ORDER BY house_no ASC;`;
        res.json({ success: true, tenants });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/tenants', async (req, res) => {
    try {
        const { houseNo, tenantName, phone, roomRent, status } = req.body;
        await sql`
            INSERT INTO tenants (house_no, tenant_name, phone, room_rent, status)
            VALUES (${houseNo}, ${tenantName}, ${phone}, ${roomRent || 0}, ${status || 'รอชำระ'})
            ON CONFLICT (house_no) DO UPDATE 
            SET tenant_name = EXCLUDED.tenant_name, phone = EXCLUDED.phone, room_rent = EXCLUDED.room_rent, status = EXCLUDED.status;
        `;
        res.json({ success: true, message: 'บันทึกสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/tenants/status/:id', async (req, res) => {
    try {
        const { status } = req.body;
        await sql`UPDATE tenants SET status = ${status} WHERE id = ${req.params.id};`;
        res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/tenants/:id', async (req, res) => {
    try {
        await sql`DELETE FROM tenants WHERE id = ${req.params.id};`;
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// -----------------------------------------------------------------------------
// 🟢 API ออกบิลค่าปรับ
// -----------------------------------------------------------------------------
app.post('/api/generate-fine-bill', async (req, res) => {
    try {
        const { houseNo, tenantName, dueDate, overdueDays, fineRate, totalFine, note } = req.body;
        if (!houseNo) {
            return res.status(400).json({ success: false, message: 'กรุณาเลือกบ้านเลขที่' });
        }

        const activePayment = await sql`SELECT * FROM payment_methods WHERE is_active = TRUE LIMIT 1;`;
        let paymentText = '';
        if (activePayment.length > 0) {
            const p = activePayment[0];
            if (p.type === 'bank') {
                paymentText = `\n--------------------------------\n💳 ช่องทางชำระเงิน:\nธนาคาร${p.bank_name}\nเลขบัญชี: ${p.account_no}\nชื่อบัญชี: ${p.account_name}`;
            } else {
                paymentText = `\n--------------------------------\n📱 ช่องทางชำระเงิน:\nพร้อมเพย์ (PromptPay)\nหมายเลข: ${p.account_no}\nชื่อบัญชี: ${p.account_name}`;
            }
        }

        const noteSection = note ? `\n📌 หมายเหตุ: ${note}` : '';

        const messageText = 
`⚠️ แจ้งยอดค่าปรับเกินกำหนดชำระ (บ้านเลขที่ ${houseNo})
--------------------------------
👤 ผู้เช่า: ${tenantName || 'ผู้เช่า'}
📅 กำหนดชำระเดิม: ${dueDate}
⏰ เกินกำหนดชำระแล้ว: ${overdueDays} วัน
💸 อัตราค่าปรับ: ${Number(fineRate).toLocaleString()} บาท/วัน
--------------------------------
💰 ยอดค่าปรับรวมทั้งสิ้น: ${Number(totalFine).toLocaleString()} บาท${noteSection}${paymentText}`;

        await sql`
            INSERT INTO bills (house_no, tenant_name, grand_total, message_text)
            VALUES (${houseNo}, ${tenantName || ''}, ${totalFine}, ${messageText});
        `;

        res.json({ success: true, totalFine, messageText });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// -----------------------------------------------------------------------------
// 🟢 API จัดการช่องทางชำระเงิน (Payment Methods)
// -----------------------------------------------------------------------------
app.get('/api/payment-methods', async (req, res) => {
    try {
        const methods = await sql`SELECT * FROM payment_methods ORDER BY id ASC;`;
        res.json({ success: true, methods });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/payment-methods', async (req, res) => {
    try {
        const { type, bankName, accountNo, accountName } = req.body;
        const count = await sql`SELECT COUNT(*) FROM payment_methods;`;
        const isFirst = parseInt(count[0].count) === 0;

        await sql`
            INSERT INTO payment_methods (type, bank_name, account_no, account_name, is_active)
            VALUES (${type}, ${bankName || null}, ${accountNo}, ${accountName}, ${isFirst});
        `;
        res.json({ success: true, message: 'เพิ่มช่องทางสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/payment-methods/active/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await sql`UPDATE payment_methods SET is_active = FALSE;`;
        await sql`UPDATE payment_methods SET is_active = TRUE WHERE id = ${id};`;
        res.json({ success: true, message: 'ตั้งเป็นช่องทางหลักสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/payment-methods/:id', async (req, res) => {
    try {
        await sql`DELETE FROM payment_methods WHERE id = ${req.params.id};`;
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} with Neon PostgreSQL`);
});