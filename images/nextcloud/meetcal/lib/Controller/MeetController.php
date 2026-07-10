<?php
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\Meetcal\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Http\Client\IClientService;
use OCP\IRequest;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

class MeetController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IEventDispatcher $eventDispatcher,
        private IClientService $clientService,
        private IUserSession $userSession,
        private LoggerInterface $logger,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * Create (or get) a Meet room for an event idempotency key and return its URL.
     * Same-origin endpoint called by the Calendar editor's injected JS.
     */
    /** Build a stable, non-identifying xxx-yyyy-zzz code for this user's event. */
    private function roomCode(string $userId, string $idempotencyKey): string {
        $digest = hash('sha256', $userId . "\0" . $idempotencyKey, true);
        $letters = '';
        for ($i = 0; $i < 10; $i++) {
            $letters .= chr(ord($digest[$i]) % 26 + ord('a'));
        }
        return substr($letters, 0, 3) . '-' . substr($letters, 3, 4) . '-' . substr($letters, 7, 3);
    }

    #[NoAdminRequired]
    public function room(string $idempotencyKey = ''): JSONResponse {
        $userId = $this->userSession->getUser()?->getUID() ?? '';
        if ($userId === '') {
            return new JSONResponse(['error' => 'not_authenticated'], Http::STATUS_UNAUTHORIZED);
        }
        if (strlen($idempotencyKey) < 8 || strlen($idempotencyKey) > 200) {
            return new JSONResponse(['error' => 'invalid_idempotency_key'], Http::STATUS_BAD_REQUEST);
        }

        $eventClass = 'OCA\\UserOIDC\\Event\\ExchangedTokenRequestedEvent';
        if (!class_exists($eventClass)) {
            return new JSONResponse(['error' => 'user_oidc unavailable'], Http::STATUS_SERVICE_UNAVAILABLE);
        }

        // Mint a `meet`-audience token for the current user (internal->internal
        // exchange; no target client secret needed).
        $accessToken = null;
        try {
            $event = new $eventClass('meet');
            $this->eventDispatcher->dispatchTyped($event);
            $token = $event->getToken();
            $accessToken = $token?->getAccessToken();
        } catch (\Throwable $e) {
            $this->logger->warning('meetcal: token exchange failed: ' . $e->getMessage());
        }
        if (!$accessToken) {
            return new JSONResponse(['error' => 'no_token'], Http::STATUS_UNAUTHORIZED);
        }

        // nextcloud.<base> -> meet.<base>
        $host = $this->request->getServerHost();
        $meetBase = 'https://' . preg_replace('/^nextcloud\./', 'meet.', $host, 1);
        $api = $meetBase . '/api/v1.0/rooms/';
        // Repeated requests for the same event resolve to the same room. This
        // prevents Calendar DOM remounts, retries, and smoke runs leaking rooms.
        $roomName = $this->roomCode($userId, $idempotencyKey);

        $client = $this->clientService->newClient();
        $headers = ['Authorization' => 'Bearer ' . $accessToken, 'Content-Type' => 'application/json'];

        $slug = null;
        try {
            // access_level "public" so anyone with the calendar link can join
            // (like Google Meet); the default is "restricted" (owner only).
            $resp = $client->post($api, ['headers' => $headers, 'body' => json_encode([
                'name' => $roomName,
                'access_level' => 'public',
            ])]);
            if ($resp->getStatusCode() === 201) {
                $slug = (json_decode($resp->getBody(), true)['slug'] ?? null);
            }
        } catch (\Throwable $e) {
            // A duplicate-name response is expected on an idempotent retry.
            $this->logger->debug('meetcal: create returned error, will look up: ' . $e->getMessage());
        }

        if (!$slug) {
            try {
                $list = $client->get($api, ['headers' => $headers, 'query' => ['page_size' => '200']]);
                $data = json_decode($list->getBody(), true);
                $rooms = is_array($data) ? ($data['results'] ?? $data) : [];
                foreach (($rooms ?: []) as $r) {
                    if (($r['name'] ?? null) === $roomName) { $slug = $r['slug'] ?? null; break; }
                }
            } catch (\Throwable $e) {
                $this->logger->warning('meetcal: room lookup failed: ' . $e->getMessage());
            }
        }

        if (!$slug) {
            return new JSONResponse(['error' => 'room_failed'], Http::STATUS_BAD_GATEWAY);
        }
        return new JSONResponse(['url' => $meetBase . '/' . $slug]);
    }
}
