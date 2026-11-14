import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { PaystackProvider } from "../src/payments/paystack.js";
import { PaymentProviderError } from "../src/payments/provider.js";
import { applyBasisPoints, cedisToPesewas, formatGhs, assertPositiveMinorAmount, } from "../src/lib/money.js";
import { isProviderSafeReference, newReference } from "../src/lib/reference.js";
let pass = 0;
let fail = 0;
const check = (c, m) => {
    if (c) {
        console.log(`  PASS  ${m}`);
        pass++;
    }
    else {
        console.log(`  FAIL  ${m}`);
        fail++;
    }
};
async function throws(label, fn, needle) {
    try {
        await fn();
        check(false, `${label} - expected throw, got none`);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (needle && !msg.includes(needle))
            check(false, `${label} - wrong error: ${msg}`);
        else
            check(true, `${label}\n          -> ${msg.split("\n")[0]}`);
    }
}
const recorded = [];
let handler = () => { };
const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        recorded.push({
            method: req.method ?? "",
            url: req.url ?? "",
            body: raw ? JSON.parse(raw) : null,
            auth: req.headers.authorization,
        });
        handler(req, res, raw);
    });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const SECRET = "sk_test_" + "a".repeat(32);
const provider = new PaystackProvider({ secretKey: SECRET, baseUrl });
function reply(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
}
const ok = (data) => (_q, res) => reply(res, 200, { status: true, message: "ok", data });
console.log("1. Constructor validation");
await throws("publishable key rejected", () => new PaystackProvider({ secretKey: "pk_test_x" }), 'must start with "sk_"');
check(provider.isTestMode, "sk_test_ key reports isTestMode");
check(new PaystackProvider({ secretKey: "sk_live_" + "b".repeat(32) }).isTestMode === false, "sk_live_ key reports NOT test mode");
console.log("\n2. initiateCheckout");
recorded.length = 0;
handler = ok({
    authorization_url: "https://checkout.paystack.com/abc123",
    access_code: "acc_123",
    reference: "tkt-abcdefghijklmnopqr",
});
const session = await provider.initiateCheckout({
    reference: "tkt-abcdefghijklmnopqr",
    amountMinor: 150_00,
    currency: "GHS",
    customerEmail: "buyer@example.com",
    callbackUrl: "https://bafle.test/paid",
    metadata: { raffleId: "r1" },
});
check(session.redirectUrl === "https://checkout.paystack.com/abc123", "redirectUrl mapped");
check(session.providerRef === "acc_123", "access_code -> providerRef");
const sent = recorded[0].body;
check(recorded[0].url === "/transaction/initialize", "POST /transaction/initialize");
check(recorded[0].auth === `Bearer ${SECRET}`, "secret key sent as bearer token");
check(sent.amount === 15000 && Number.isInteger(sent.amount), "amount sent as integer minor units");
check(sent.currency === "GHS", "currency GHS");
check(sent.reference === "tkt-abcdefghijklmnopqr", "our reference forwarded (idempotency key)");
await throws("non-integer amount rejected before any HTTP call", () => provider.initiateCheckout({
    reference: "tkt-abcdefghijklmnopqr",
    amountMinor: 1500.5,
    currency: "GHS",
    customerEmail: "b@e.com",
}), "whole pesewas");
console.log("\n3. confirmPayment status mapping");
const cases = [
    ["success", "succeeded"],
    ["failed", "failed"],
    ["abandoned", "abandoned"],
    ["reversed", "reversed"],
    ["ongoing", "pending"],
    ["weird_new_status", "pending"],
];
for (const [paystackStatus, expected] of cases) {
    handler = ok({
        id: 99,
        status: paystackStatus,
        reference: "ref1",
        amount: 15000,
        currency: "GHS",
        channel: "mobile_money",
        paid_at: "2026-11-11T07:00:00.000Z",
        gateway_response: "Declined",
        fees: 225,
    });
    const snap = await provider.confirmPayment("ref1");
    check(snap.state === expected, `"${paystackStatus}" -> ${snap.state} (expected ${expected})`);
}
handler = ok({
    id: 99,
    status: "success",
    reference: "ref1",
    amount: 15000,
    currency: "GHS",
    channel: "mobile_money",
    paid_at: "2026-11-11T07:00:00.000Z",
    gateway_response: "Successful",
    fees: 225,
});
const paid = await provider.confirmPayment("ref1");
check(paid.feeMinor === 225, "provider fee captured (escrow < ticket total)");
check(paid.paidAt instanceof Date, "paid_at parsed to Date");
check(paid.failureReason === null, "no failureReason on success");
console.log("\n4. Retry policy");
recorded.length = 0;
let hits = 0;
handler = (_q, res) => {
    hits++;
    if (hits < 3)
        reply(res, 500, { status: false, message: "server error" });
    else
        reply(res, 200, {
            status: true,
            message: "ok",
            data: { authorization_url: "u", access_code: "a", reference: "r" },
        });
};
await provider.initiateCheckout({
    reference: "tkt-abcdefghijklmnopqr",
    amountMinor: 100,
    currency: "GHS",
    customerEmail: "b@e.com",
});
check(hits === 3, `idempotent checkout retried 5xx (attempts=${hits})`);
recorded.length = 0;
hits = 0;
handler = (_q, res) => {
    hits++;
    reply(res, 500, { status: false, message: "server error" });
};
await throws("refund does NOT retry (could double-refund)", () => provider.refund({ paymentReference: "ref1", amountMinor: 100, reason: "raffle expired" }));
check(hits === 1, `refund attempted exactly once (attempts=${hits})`);
hits = 0;
handler = (_q, res) => {
    hits++;
    reply(res, 400, { status: false, message: "Invalid reference" });
};
await throws("4xx not retried", () => provider.confirmPayment("nope"));
check(hits === 1, `4xx attempted exactly once (attempts=${hits})`);
console.log("\n5. Error surface");
handler = (_q, res) => reply(res, 200, { status: false, message: "Transaction not found" });
try {
    await provider.confirmPayment("ref1");
    check(false, "status:false should throw");
}
catch (e) {
    const err = e;
    check(err instanceof PaymentProviderError, "throws PaymentProviderError");
    check(err.providerMessage === "Transaction not found", `provider message preserved -> ${err.providerMessage}`);
    check(err.provider === "paystack", "error tagged with provider");
    check(err.retryable === false, "HTTP 200 + status:false marked non-retryable");
}
console.log("\n6. createRecipient / payout");
handler = ok({ recipient_code: "RCP_abc", details: { account_number: "0244123456" } });
const recipient = await provider.createRecipient({
    kind: "mobile_money",
    accountName: "Kwame Mensah",
    accountNumber: "0244123456",
    bankCode: "MTN",
    currency: "GHS",
});
check(recipient.recipientCode === "RCP_abc", "recipient_code mapped");
check(recipient.accountNumberLast4 === "3456", `only last4 retained -> ${recipient.accountNumberLast4}`);
check(recorded.at(-1).body.type === "mobile_money", "mobile_money type sent");
handler = ok({ recipient_code: "RCP_bank", details: { account_number: "1234567890" } });
await provider.createRecipient({
    kind: "bank",
    accountName: "X",
    accountNumber: "1234567890",
    bankCode: "030",
    currency: "GHS",
});
check(recorded.at(-1).body.type === "ghipss", 'bank maps to "ghipss" (Ghana rail), not "nuban"');
for (const [st, expected] of [
    ["success", "succeeded"],
    ["otp", "processing"],
    ["failed", "failed"],
    ["reversed", "reversed"],
]) {
    handler = ok({ transfer_code: "TRF_1", reference: "pay-abcdefghijklmnopqr", status: st, amount: 500 });
    const out = await provider.payout({
        reference: "pay-abcdefghijklmnopqr",
        amountMinor: 500,
        recipientCode: "RCP_abc",
        reason: "raffle payout",
    });
    check(out.state === expected, `transfer "${st}" -> ${out.state}`);
}
check(recorded.at(-1).body.source === "balance", 'transfer sends source="balance"');
console.log("\n7. Webhook verification");
const bodyObj = { event: "charge.success", data: { reference: "tkt-abc", amount: 15000 } };
const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
const sig = createHmac("sha512", SECRET).update(raw).digest("hex");
const envelope = provider.verifyWebhook(raw, { "x-paystack-signature": sig });
check(envelope !== null, "valid HMAC-SHA512 signature accepted");
check(envelope?.eventType === "charge.success", "event type extracted");
check(envelope?.eventId === "paystack:charge.success:tkt-abc", `dedupe key derived from type+entity -> ${envelope?.eventId}`);
check(provider.verifyWebhook(raw, {}) === null, "missing signature header rejected");
check(provider.verifyWebhook(raw, { "x-paystack-signature": "deadbeef" }) === null, "wrong-length signature rejected (no timingSafeEqual throw)");
const forged = createHmac("sha512", "sk_test_" + "z".repeat(32)).update(raw).digest("hex");
check(provider.verifyWebhook(raw, { "x-paystack-signature": forged }) === null, "signature from a different secret rejected");
const tampered = Buffer.from(JSON.stringify({ ...bodyObj, data: { reference: "tkt-abc", amount: 999999 } }));
check(provider.verifyWebhook(tampered, { "x-paystack-signature": sig }) === null, "tampered body rejected (amount changed)");
const noEvent = Buffer.from(JSON.stringify({ data: { reference: "x" } }));
check(provider.verifyWebhook(noEvent, {
    "x-paystack-signature": createHmac("sha512", SECRET).update(noEvent).digest("hex"),
}) === null, "signed body with no event field rejected");
console.log("\n8. Money helpers");
check(cedisToPesewas("12.50") === 1250, "12.50 cedis -> 1250 pesewas");
check(cedisToPesewas(0.1) + cedisToPesewas(0.2) === cedisToPesewas(0.3), "0.1+0.2 == 0.3 in minor units");
check(cedisToPesewas(12.505) === 1251, "rounds rather than truncates (12.505 -> 1251)");
check(formatGhs(1250) === "GHS 12.50", `formatGhs(1250) -> ${formatGhs(1250)}`);
check(formatGhs(5) === "GHS 0.05", `formatGhs(5) -> ${formatGhs(5)}`);
check(applyBasisPoints(10_000, 250) === 250, "2.5% of 10000 = 250");
check(applyBasisPoints(999, 250) === 24, "fee floors down (24, not 25) so platform never over-takes");
await throws("Int column overflow rejected", () => assertPositiveMinorAmount(3_000_000_000), "Int column");
await throws("negative cedis rejected", () => cedisToPesewas(-1), "valid cedi amount");
console.log("\n9. Reference charset (both Paystack rules)");
const refs = new Set();
for (let i = 0; i < 500; i++)
    refs.add(newReference("tkt"));
check(refs.size === 500, `500 references, 0 collisions (${refs.size} unique)`);
const sample = [...refs];
check(sample.every((r) => /^[a-z0-9-]+$/.test(r)), "all lowercase alphanumeric + hyphen (transfer rule)");
check(sample.every((r) => r.length >= 16), "all >= 16 chars (transfer minimum)");
check(sample.every((r) => isProviderSafeReference(r)), "all pass isProviderSafeReference");
await throws("bad prefix rejected", () => newReference("TKT"), "lowercase letters");
console.log("\n10. Production guards (separate processes)");
function bootEnv(extra) {
    try {
        const out = execFileSync(process.execPath, ["--experimental-strip-types", "-e", 'import("./src/env.ts").then(()=>console.log("BOOTED"))'], { env: { ...process.env, ...extra }, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
        return { code: 0, output: out };
    }
    catch (e) {
        const err = e;
        return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
}
const g1 = bootEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "mock", CORS_ORIGINS: "https://x.test" });
check(g1.code !== 0 && /never happened/.test(g1.output), "production + mock refuses to boot");
const g2 = bootEnv({
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "paystack",
    PAYSTACK_SECRET_KEY: "sk_test_abc",
    CORS_ORIGINS: "https://x.test",
});
check(g2.code !== 0 && /TEST key/.test(g2.output), "production + sk_test_ key refuses to boot");
const g3 = bootEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "sk_live_abc" });
check(g3.code !== 0 && /CORS_ORIGINS/.test(g3.output), "production without CORS_ORIGINS refuses to boot");
const g4 = bootEnv({ PAYMENT_PROVIDER: "nonsense" });
check(g4.code !== 0 && /PAYMENT_PROVIDER must be one of/.test(g4.output), "unknown provider name rejected");
const g5 = bootEnv({ NODE_ENV: "development", PAYMENT_PROVIDER: "mock" });
check(g5.code === 0 && /BOOTED/.test(g5.output), "development + mock boots fine");
stub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
//# sourceMappingURL=payments.test.mjs.map