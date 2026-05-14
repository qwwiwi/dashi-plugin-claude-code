# Success criteria — что доказываем перед 15.06.2026

8 чеков перед D-day:

- [ ] **Anthropic dashboard: zero SDK credit usage за 7 дней**
  Весь Telegram-трафик 5 агентов идёт в subscription pool, не в Agent SDK credit.

- [ ] **5/5 агентов отвечают через Channel**
  Smoke per agent: Telegram ping → ответ ≤ 30s.

- [ ] **Parity: streams + media + voice + albums работают**
  A/B vs gateway.py на 50 реальных turn'ах. Нет регрессии в UX.

- [ ] **Launchd reboot test: сессия поднимается без human input**
  Mac mini рестарт → 2 мин → Channel принимает первый event.

- [ ] **Permission relay: 100% approval roundtrip ≤ 60s**
  10 примеров Bash/Write tool approvals через Telegram коды.

- [ ] **Tyrande берёт 100% крон-логики, ноль Anthropic-вызовов в crons**
  grep на всех хостах: 0 совпадений `claude -p` / `@anthropic-ai/sdk` в крон-скриптах.

- [ ] **Loop guards: synthetic bot-loop тест → halt после 3 hops**
  Depth-limit реально срабатывает, dedupe работает, rate-limit работает.

- [ ] **Anthropic support письменно подтверждает классификацию**
  Email на руках с явным «yes, this counts as interactive subscription usage».

## Rollback strategy

| Сценарий | Действие |
|----------|----------|
| Phase 0 FAIL (канарейка показала SDK) | Гибрид tmux/screen + Tyrande берёт больше |
| Phase 1–2 прототип не работает | gateway.py не тронут, продолжаем на нём, `launchctl unload channel` |
| Phase 4 cutover regression | Per-agent revert: enable в gateway.py + `launchctl unload channel-{agent}` |
| Phase 5 observation drift | `launchctl load ai.orgrimmar.gateway`, parallel-mode 1 день, root-cause, retry |
