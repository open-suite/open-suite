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
use Psr\Log\LoggerInterface;

class MeetController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IEventDispatcher $eventDispatcher,
        private IClientService $clientService,
        private LoggerInterface $logger,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * Create (or get) a Meet room for `name` and return its URL.
     * Same-origin endpoint called by the Calendar editor's injected JS.
     */
    /** La Suite Meet rooms are addressed by a code-format slug (xxx-yyyy-zzz);
     *  a human title isn't a joinable slug, so each room gets a fresh code. */
    private function generateCode(): string {
        $letters = 'abcdefghijklmnopqrstuvwxyz';
        $pick = function (int $n) use ($letters): string {
            $s = '';
            for ($i = 0; $i < $n; $i++) {
                $s .= $letters[random_int(0, strlen($letters) - 1)];
            }
            return $s;
        };
        return $pick(3) . '-' . $pick(4) . '-' . $pick(3);
    }

    #[NoAdminRequired]
    public function room(string $name = ''): JSONResponse {
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
        // The room is identified by a generated code; the event keeps its own title.
        $roomName = $this->generateCode();

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
            // Likely a duplicate-name 400; fall through to lookup.
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
