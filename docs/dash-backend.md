# Dash Backend Core Technical Documentation

## Purpose

`dash-backend` is the reusable Laravel core for all Dash-based solutions. It provides the platform capabilities that every domain can rely on, while allowing each client or product domain to contribute its own routes, models, controllers, migrations, resources, and business rules through the mounted `domain` layer.

This document focuses on the core feature set implemented in `dash-backend`, how those features are wired in the codebase, and how new domains should use the core without moving domain-specific logic back into the core.

## Workspace Layout

```text
DASH-PROJECT/
├── dash-backend/           # Core Laravel application (private to DashPanel developers, optional for client teams)
└── dash-backend-docker/    # Runtime project that mounts a built core image and a domain folder
└── custom-domain/          # Custom domain business layer implementation
```

## Core Responsibilities

The core owns platform-level concerns that must remain stable across all domains:

- Authentication and user session management.
- Role and permission management.
- Tenancy and tenant lifecycle.
- Subscription plans, add-ons, and plan limits.
- Billing and payment gateway integration.
- Email, notifications, queues, and websocket infrastructure.
- Shared resources such as currencies, languages, countries, regions, communes, files, and media integration.
- Public APIs and administration APIs that domains can reuse.
- Shared migrations and base data seeders.

The core must not become the home for client-only business entities. In this workspace, currencies, tenancies, subscriptions, and payments belong to the core, while product/catalog/ecommerce features belong to a domain such as `kitchntabs-domain`, not to `fablabos` unless that domain truly uses them.

## Feature Map

## Authentication and Identity

Core authentication lives in the Laravel API layer and is exposed from `routes/api.php` through controllers such as:

- `App\Http\Controllers\API\Auth\LoginController`
- `App\Http\Controllers\API\Auth\AuthenticatedUserController`
- `App\Http\Controllers\API\Auth\RefreshTokenController`
- `App\Http\Controllers\API\Auth\EmailVerificationController`
- `App\Http\Controllers\API\Auth\ForgotPasswordController`
- `App\Http\Controllers\API\Auth\ResetPasswordController`
- `App\Http\Controllers\API\Auth\TrialRegistrationController`

Core capabilities include:

- Login, logout, and logout-all.
- Refresh token rotation and session management.
- Email verification.
- Password reset.
- Authenticated user profile updates.
- Trial registration and deferred provisioning.

How domains use it:

- Domains should consume the authenticated user, tenant, and tenancy already resolved by the core.
- Domains should define only domain-specific authorization checks on top of the existing role and policy system.
- Do not duplicate login or identity flows in the domain layer.

## Roles, Permissions, and Access Control

The core provides the user-level security model used by all domains:

- System administrators operate above tenancy limits and cross-tenant boundaries.
- Tenancy administrators manage tenants inside one tenancy.
- Tenant administrators manage only their assigned tenant.
- Normal users are restricted to their allowed surfaces.

This is reinforced by:

- Core policies such as `App\Policies\TenantPolicy`.
- Authenticated admin routes loaded from `routes/system.php`, `routes/tenant.php`, and `routes/tenancy.php`.
- Feature tests under `tests/Feature/DASH/Admin/*`, `tests/Feature/DASH/SystemAdmin/*`, and `tests/Feature/Controllers/TenantAuthorizationTest.php`.

How domains use it:

- Reuse the core roles and policies first.
- Add domain policies only when the protected resource is domain-owned.
- Avoid redefining platform roles in the domain unless the domain is adding a truly new permission surface.

## Tenancy Management

Tenancy is one of the main platform features of the core.

There are two important concepts:

- `Tenancy`: the account or organization boundary used for subscription, billing, and plan limits.
- `Tenant`: the operational tenant instance managed inside a tenancy.

The main controller for tenancy-scoped tenant CRUD is `App\Http\Controllers\API\Tenancy\TenancyTenantController`.

Key implementation details:

- It extends the system tenant controller and centralizes tenant creation and update behavior.
- It enforces plan limits through `App\Services\Subscription\PlanLimitsService`.
- It scopes listings and reads to the current user tenancy.
- It uses domain-aware resources for relationship-rich responses.
- It syncs currencies, languages, marketplaces, POS integrations, schedules, and media.
- It now guards optional domain integrations so core flows do not hard-fail when a mounted domain does not implement ecommerce-specific relations.

Core-owned tenant data includes:

- `tenancy_id`
- currencies and primary currency
- languages and primary language
- settings
- attributes
- schedule flags
- core tenant authorization rules

How domains use it:

- Domains can extend tenant serialization or behavior through the domain `Extended\Tenant` model, request, and resource.
- Domain code should enrich core tenants with domain-specific relationships, but must not redefine core-owned identity, tenancy, currency, subscription, or payment concepts.
- If a domain needs extra tenant-level fields, add them as domain-specific attributes or relationships rather than changing core semantics.

## Subscription Plans and Plan Limits

The core provides subscription plan modeling and limit enforcement.

Main implementation surfaces:

- `App\Models\Subscription\SubscriptionPlan`
- `App\Models\TenancySubscription`
- `App\Services\Subscription\PlanLimitsService`
- `App\Http\Controllers\API\Subscription\SubscriptionPlanController`
- `routes/subscription.php`

Supported core behaviors include:

- Public plan listing.
- Plan CRUD for administrators.
- Plan limits stored in JSON.
- Add-ons stored alongside plan configuration.
- Effective plan resolution for current subscriptions.
- Plan-based limits such as maximum tenants and users.
- System-admin bypass for plan checks.

`PlanLimitsService` is the central contract for limit checks.

Important current rules:

- `0`, `null`, and `-1` mean unlimited.
- System administrators bypass limits.
- Limits are enforced from the effective active plan.
- Optional domain-owned limits are counted only if the model exists.

This last point is important for separation of concerns: the core service can observe optional domain model counts through guarded lookups, but the core does not require those domain models to exist in order to function.

How domains use it:

- Add domain-dependent limits only if the core limit contract remains optional and tolerant of absent domain classes.
- Domain features should ask the core whether a tenancy is within its entitlement before creating billable resources.
- Domain code should not implement a second subscription-plan system.

## Billing and Payments

The core owns billing state, subscriptions, payment gateway association, and webhook entry points.

Important implementation areas:

- Payment webhooks are registered in `routes/api.php` under `payments/webhooks`.
- Billing events live under `App\Events\Billing`.
- Billing enums such as `BillingState`, `SubscriptionState`, and `TenancyAccountStatus` live under `App\Enums`.
- Payment gateway support and wiring are implemented through core services and models such as `SystemPaymentGateway`, tenancy-gateway associations, and billing jobs/listeners.
- Subscription plan changes trigger gateway synchronization through `App\Observers\SubscriptionPlanObserver` and `SyncPaymentGatewayPlansJob`.

Core billing responsibilities include:

- Maintaining the local reflection of payment gateway state.
- Receiving webhook notifications from supported gateways.
- Associating active gateways to tenancies.
- Driving invoices, payment receipts, and billing notifications.
- Enforcing account restriction rules when subscriptions lapse or accounts are suspended.

How domains use it:

- Domains should treat billing as a core service.
- Domain features can react to tenancy billing state, but should not implement independent payment authority or separate subscription ledgers.
- If a domain introduces a new payable feature, integrate it through the core billing abstraction instead of creating an isolated payment flow.

## Shared Master Data

The core also provides platform-wide reference entities used by many domains:

- currencies
- languages
- countries
- regions
- communes
- users
- roles
- permissions
- file upload and media plumbing

These entities are reusable and should stay domain-agnostic. Domains may reference them, but should not fork them unless there is a strong architectural reason.

## Messaging, Notifications, and Realtime

The core includes a full messaging platform, not only email delivery. It already provides persisted notifications, websocket messaging, broadcast authorization, push notification endpoints, and queue-backed delivery.

### In-App Notifications

User-facing notification APIs are implemented by `App\Http\Controllers\API\Messaging\NotificationController` and exposed from `routes/api.php` under the `notifications` prefix.

Current core capabilities include:

- listing notifications for the authenticated user
- reading a single notification
- marking notifications as read
- filtering by `reference_type`, `reference_id`, and read status
- sending public and private message notifications through the same builder pipeline

Implementation anchors:

- notifications are stored as `Illuminate\Notifications\DatabaseNotification`
- notification responses use `App\Http\Resources\NotificationResource`
- query filtering uses `App\ModelFilters\NotificationsFilter`
- delivery is coordinated through `App\AppNotifications\AppNotificationBuilder`

### Email Notifications

The core also owns email-based notifications and mailables for platform workflows.

Examples already present in `app/Notifications` and `app/Mail` include:

- verification email notifications
- password reset notifications
- trial welcome and trial verification mail
- tenancy subscription cancellation mail
- billing payment received notifications

Important characteristics:

- several mail and notification classes implement `ShouldQueue`
- locale-aware rendering is already supported
- auth and billing email flows remain in the core because they are platform-owned behaviors
- local inspection is supported through Mailhog in `dash-backend-docker`

### Websocket Messaging and Broadcast Channels

Realtime delivery is exposed through websocket endpoints and broadcast channel authorization.

Important API surfaces:

- `POST /api/ws/trigger`
- `POST /api/ws/trigger/{userId}`
- `POST /api/ws/channel`
- `POST /api/ws/chat/{tenantId}`
- `POST /api/ws/auth`

These are implemented through:

- `App\Http\Controllers\API\Messaging\WebSocketTestController`
- `App\Http\Controllers\API\Messaging\WebSocketTenantController`
- `App\Http\Controllers\DashBroadcastAuthController`

Authorized broadcast channels are declared in `routes/channels.php`, including:

- `session.{sessionId}`
- `user.{id}`
- `tenant.{tenantId}`
- `tenant.{tenantId}.system`
- `tenant.{tenantId}.chat`

The current delivery model supports:

- private user-targeted messages
- tenant-wide channel notifications
- tenant chat messages
- session-scoped notification flows

Notification emission uses `AppNotificationBuilder` with notification classes such as `PublicMessageNotification`, `PrivateMessageNotification`, and `TenantChannelMessageNotification`.

### Push Notifications

The core also includes Firebase Cloud Messaging support through `routes/system.php`.

Current system endpoints cover:

- FCM token registration
- single-recipient push sends
- bulk push sends
- configuration and test endpoints for diagnostics

This keeps push delivery in the same platform messaging layer rather than scattering it across domain-specific services.

### Self-Service Notifications

The self-service route set also exposes notification reads through `routes/selfservice.php`.

Current endpoints include:

- `GET /{hash}/notifications`
- `POST /{hash}/notifications/read`
- `GET /session/{hash}/notifications`

This is relevant because messaging is not only for back-office users. The core also supports session-based client experiences.

### Runtime Requirements

The messaging stack depends on runtime services already included in the Docker setup:

- the Laravel app container
- Redis for queue storage
- Horizon for queue workers
- Reverb for websocket transport
- Mailhog for local email capture

If Horizon or Reverb are not running, queued notifications or realtime delivery may appear incomplete even when the API endpoints are healthy.

How domains use it:

- Domains should publish domain-specific events and notifications through `AppNotificationBuilder` and the existing Laravel notification system.
- Domains can add new notification classes and payload shapes, but should reuse the core channels, queue workers, and broadcast authentication flow.
- Avoid bootstrapping a parallel websocket stack, push subsystem, or isolated notification persistence model in the domain.

## Domain Extension Model

The domain layer is loaded as an optional module mounted into `/var/www/html/domain`.

Main integration points:

- `domain/routes/api.php`
- domain PSR-4 namespaces under `Domain\App\...`
- domain migrations under `domain/database`
- domain resources, controllers, filters, services, and models

The core already anticipates the domain layer by:

- loading domain routes if present
- referencing domain classes when they exist
- using extended tenant resources/controllers where appropriate
- tolerating absent domain-owned models through guarded checks

Recommended extension strategy:

1. Put platform-neutral capabilities in the core.
2. Put client-specific workflows and models in the domain.
3. Extend core entities through domain wrappers rather than forking core behavior.
4. Use `method_exists` and `class_exists` only at boundary points where the core must remain compatible with multiple domains.
5. Keep ownership clear: if a feature is not universal, it should not become a core dependency.

## How To Use Core Features In New Domains

When creating a new domain, reuse the core instead of copying platform logic.

Use the core directly for:

- authentication
- tenancy and tenant lifecycle
- subscriptions and plan limits
- payment gateways and billing state
- permissions and roles
- shared master data
- queues, notifications, and websocket infrastructure

Add domain code only for:

- client-specific models
- client-specific routes
- domain-only services and automation
- custom resources and controllers that decorate core entities
- domain-only migrations and seed data

When evaluating where a new feature belongs, use this rule:

- If more than one domain should depend on it, put it in the core.
- If it is specific to one client or vertical, keep it in the domain.

In this workspace, ecommerce entities such as products and categories are a domain concern and belong in `kitchntabs-domain`, not in the generic core and not in `fablabos` unless that domain explicitly requires them.

## Core Test Suite

The Core suite validates that the reusable platform works independently of a specific business domain.

Run it with:

```bash
docker compose exec app php artisan test --testsuite Core
```

Generate JUnit output with:

```bash
docker compose exec app php artisan test --testsuite=Core --log-junit /var/www/html/reports/core_results.xml --no-ansi
```

Important suite areas include:

- tenancy CRUD and tenancy authorization
- system admin tenant management
- subscription plan management and add-ons
- plan limit enforcement
- billing and payment gateway integration
- authentication and admin CRUD APIs
- email and notification behavior

Examples from the current suite:

- `Tests\Feature\Controllers\TenancyTenantCrudTest`
- `Tests\Feature\Controllers\TenantAuthorizationTest`
- `Tests\Feature\Subscription\PlanLimitsEnforcementTest`
- `Tests\Feature\Payments\PaymentGatewayTest`
- `Tests\Feature\DASH\SystemAdmin\SystemAdminTenantManagementTest`

Latest available report snapshot from `dash-backend-docker/reports/core_results.xml`:

- 613 tests
- 2227 assertions
- 17 skipped tests
- 1 remaining failure in `Tests\Feature\SeededSystemFlowTest`

Interpretation:

- Core platform functionality is now largely green.
- Remaining work is concentrated in a seeded end-to-end flow test rather than broad platform instability.
- Domain-independent tenant, subscription, payment, admin, and authorization slices are already validated by the core suite.

## Practical Rules For Future Refactors

- Keep currencies, tenancies, subscriptions, and payments in the core.
- Keep optional domain-only business models out of the core dependency chain.
- Refactor product and category logic toward `kitchntabs-domain`, where that business capability actually belongs.
- Do not add new domain requirements to core tests unless the feature is genuinely core-owned.
- Prefer extension over duplication: a domain should wrap or compose core functionality instead of copying it.

## Summary

`dash-backend` is the reusable platform layer. It owns identity, tenancy, subscription, billing, payments, shared reference data, and infrastructure concerns. Domains should build on top of those guarantees, not replace them. Keeping that boundary clean is what allows one core to support multiple business domains without turning domain-specific assumptions into platform regressions.
