# proxy-sc

Минимальный прокси для SoundCloud-статистики.

## Что изменено

- добавлена защита по HTTP-методам;
- добавлена валидация входных SoundCloud URL;
- добавлены таймауты и нормальная обработка ошибок;
- добавлена пагинация по `next_href` для `/users/:id/tracks`;
- добавлена поддержка OAuth через `SOUNDCLOUD_ACCESS_TOKEN` или `SOUNDCLOUD_CLIENT_ID` + `SOUNDCLOUD_CLIENT_SECRET`;
- сохранён совместимый fallback на legacy `client_id`, чтобы проект продолжил работать без дополнительной настройки;
- добавлены cache headers для снижения нагрузки;
- вынесена общая логика в `api/_lib`;
- добавлены базовые тесты.

## Быстрый старт

```bash
cp .env.example .env
npm test
```

## Переменные окружения

См. `.env.example`.

## Совместимость ответа API

`/api/dashboard` и `/api/plays` сохраняют исходные основные поля ответа. Дополнительно возвращается объект `meta`.

## Ограничения

`history` в `/api/dashboard` по-прежнему основана на ручных значениях и не вычисляется из публичного API SoundCloud. Это сделано явно и управляется флагом `DASHBOARD_INCLUDE_MANUAL_ADJUSTMENTS`.
