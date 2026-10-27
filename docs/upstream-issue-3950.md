## TL;DR

A provider that sells **prepaid credit** — a wallet — cannot be described by the current usage contract:

- **With windows**, `used` must be a share of a periodic allowance. A wallet has no such denominator, so any `used` we send is fabricated.
- **Without windows**, `routedAllowance` returns not-ok, `weighed()` leaves `Known` unset, and the Routing page says 「剩余额度未知」 — the account ranks after every known one (#3650).
- **`aside: true` does not help**: `allowanceOf()` skips those windows whole, with the same result.

What is missing is a **balance-shaped reading**: "this much is left", in a unit, with no percentage. Two fields would carry it — `QuotaWindow.Balance` and `routes.Seat.Left`.

## The provider (real numbers, 2026-10-28)

SuperMagic (超级麦吉 / MagiCrew), community plugin `magpie-magicrew-auth`.

`GET /api/v1/quota/points/total` answers:

```json
{"total_points": 6291,
 "expiring_quota_details": [
   {"remaining_points": 185, "expires_at": "2026-10-28 23:59:59"},
   {"remaining_points": 100, "expires_at": "2026-11-26 16:45:13"},
   {"remaining_points": 956, "expires_at": "2027-11-03 19:11:01"}],
 "organization_limit_points": null,
 "user_limit_points": null,
 "next_cycle_grant": null}
```

- No total, no consumed: `*_limit_points` are `null` on personal accounts.
- The ledger endpoint `POST /api/v1/quota/points/records/queries` answers **HTTP 500** on both sites (five body shapes tried), so "how much was spent" is not readable either.
- The only fixed number is the daily login gift — **200 points/day (CN), 50 (intl)** — which expires at 23:59:59 the same day.

## What the plugin tried, and what magpie did

| plugin sends | magpie | result |
|---|---|---|
| `aside: true, used: 0, display: "6,291 积分"` | `allowanceOf()` skips Aside/Text whole; none left → `routedAllowance` not ok → `weighed()` leaves `Known` unset | Routing page 「剩余额度未知」; the account ranks after every known one |
| `used: 0, display: "6,291 积分"` (no `limit`) | known, but routing's `quota()` shows the count only when `limit > 0` | row reads `0% used`, no figure |
| `used: 0, amount: 0, limit: 6291` | known, figure shown | percentage is `0 / 6291` — a tautology (denominator = remainder); the "fake share" of #3353 |

## What it costs the router

`routes.Seat` carries `Used float64` (a 0–100 share), `Soon []time.Time`, `Lapse`, `Pace`, … — **nothing that says how much is left**.

- **`pace`**: `(100 - used) / hours until resetsAt`. A wallet has no `resetsAt` and its `used` is always 0, so every account of this provider gets **the same pace**. 6,291 points and 750 points are indistinguishable.
- **`smart`**: the fine tier is ordered by `Soon` (`Allowance.Renewal`, which does fold `runsOutAt` in), then `Lapse` — it can say *whose points expire first*, never *who has more left*.

Measured on 4 accounts: 1,363 / 1,693 / 6,291 / 750 points; earliest expiries 178 / 29 / 29 / 372 days out. Under `smart` all four tie on `Soon` whenever the expiry days match; under `pace` they are **exactly** identical.

## Suggested shape

**`QuotaWindow`**

```go
// Balance is how much of this allowance is left, in Unit — a reading of a
// prepaid balance, with no share to tell (Used stays nil for it).
Balance *float64 `json:"balance,omitempty"`
```

`allowanceOf` keeps such a window (`l.Balance = *w.Balance`), so `Known` is true, without inventing a `Used`.

**`routes.Seat`**

```go
// Left is the absolute remainder in the provider's own unit: comparable
// within one provider, 0 when the vendor doesn't say.
Left float64
```

Filled from the windows' `Balance` (or the fullest window's `Amount`/`Of` when the vendor does count).

**Ordering**: `smart` / `pace` fall back to `Left` (most first) when shares are unknown or equal. A prepaid provider then becomes rankable by both dimensions that matter: *who runs out first* (`runsOutAt`) and *who has the most left* (`balance`).

## Today's plugin-side workaround (for reference)

Three windows, so the account is at least known and carries `runsOutAt`:

1. **今日积分** — today's batch, **real percentage** (denominator = the 200/50 daily gift), `resetsAt` = next midnight.
2. **限时积分** — the rest of the expiring batches, `used: 0`, `limit` = current remainder, `runsOutAt` = earliest.
3. **永久积分** — `total − Σexpiring`, `aside`, display only.

That is the best the current contract allows — and it still cannot express "how much".

## Related

- #3428 — the seat knows *when* but not *how much* is lost (`w.RunsOut` dropped in `allowanceOf`). This issue is the same gap one layer up: the seat also cannot see *how much is left at all*.
- #3352 — a `Windows: []` reading with a balance is dropped entirely, so the account is unknown.
- #3353 — a window that never moves reads as `used: 0` and distorts smart ordering.
- #3650 — a window without `used` becomes text + aside, no share.

Happy to send a PR for the two fields if the shape looks right — I can test it against this provider directly.
