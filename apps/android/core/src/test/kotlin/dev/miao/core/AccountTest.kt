package dev.miao.core

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class RosterTest {
    private val identity = P256SigningKey.generate()
    private val other = P256SigningKey.generate()
    private val accountID = "account_identifier_0001"

    private fun roster(sequence: Long, devices: List<AccountRosterDevice>, signer: P256SigningKey = identity) =
        SignedAccountRoster.sign(
            signer,
            AccountRosterPayload(accountID, sequence, 1_700_000_000_000, devices),
        )

    private fun device(key: P256SigningKey, signer: Boolean = true, label: String = "device") =
        AccountRosterDevice(key.publicKeyEncoded, label, signer, 1_700_000_000_000)

    @Test
    fun signsAndAcceptsTheInitialRoot() {
        val signed = roster(1, listOf(device(identity)))
        val authority = signed.accept(
            accountID,
            AccountRosterAuthority(accountID, 0, "", listOf(identity.publicKeyEncoded)),
        )
        assertEquals(1, authority.sequence)
        assertEquals(listOf(identity.publicKeyEncoded), authority.signerKeys)
        assertEquals(signed.fingerprint(), authority.digest)
        // A same-sequence reconnect reuses the accepted digest.
        assertEquals(authority, signed.accept(accountID, authority))
    }

    @Test
    fun rejectsRollbackForksAndForeignSigners() {
        val signed = roster(1, listOf(device(identity)))
        val authority = signed.accept(accountID, AccountRosterAuthority(accountID, 0, "", listOf(identity.publicKeyEncoded)))

        val fork = roster(1, listOf(device(other)))
        assertFailsWith<AccountRosterException> { fork.accept(accountID, authority) }

        val rollback = roster(1, listOf(device(identity)))
        assertFailsWith<AccountRosterException> {
            rollback.accept(accountID, authority.copy(sequence = 2))
        }

        val foreign = roster(2, listOf(device(identity)), signer = other)
        assertFailsWith<AccountRosterException> { foreign.accept(accountID, authority) }

        assertFailsWith<AccountRosterException> { signed.accept("another_account_00001", authority) }
    }

    @Test
    fun advanceRequiresAnAcceptedSigner() {
        val second = roster(
            2,
            listOf(device(identity), device(other, signer = false, label = "phone")).sortedBy { it.publicKey },
        )
        val authority = roster(1, listOf(device(identity)))
            .accept(accountID, AccountRosterAuthority(accountID, 0, "", listOf(identity.publicKeyEncoded)))
        val advanced = second.accept(accountID, authority)
        assertEquals(2, advanced.sequence)
        assertEquals(listOf(identity.publicKeyEncoded), advanced.signerKeys)
    }

    @Test
    fun strictDecodingRejectsUnknownFields() {
        val signed = roster(1, listOf(device(identity)))
        val bytes = CanonicalJson.encodeBytes(signed.toJson())
        assertEquals(signed, SignedAccountRoster.decode(bytes))
        val tampered = CanonicalJson.parse(bytes).objectMap!!.toMutableMap()
        tampered["extra"] = JsonValue.of(true)
        assertFailsWith<AccountRosterException> { SignedAccountRoster.decode(CanonicalJson.encodeBytes(JsonValue.Obj(tampered))) }
    }
}

class EnrollmentTest {
    private val root = P256SigningKey.generate()
    private val member = P256SigningKey.generate()
    private val accountID = "account_identifier_0001"
    private val hubURL = "https://relay.example.invalid"

    private fun grant(key: P256SigningKey, hostID: String, hostKey: P256SigningKey): AuthorizedHost {
        val grant = DeviceGrant(
            id = "grant-" + "0".repeat(20),
            version = 1,
            publicKey = key.publicKeyEncoded,
            label = "Phone",
            permissions = listOf(RemotePermission.Read),
            projectIDs = listOf("project-identifier-0001"),
            sessionIDs = emptyList(),
            createdAt = 1_700_000_000_000,
            expiresAt = System.currentTimeMillis() + 3_600_000,
        )
        val host = ApprovedHost.create(
            label = "Computer",
            hubURL = hubURL,
            target = RemoteTarget(hostID, "runtime-identifier-0001"),
            publicKey = hostKey.publicKeyEncoded,
            grantID = grant.id,
            grantVersion = grant.version,
        )
        return AuthorizedHost(host, grant)
    }

    @Test
    fun rootRequiresAnIndependentPairing() {
        val hostKey = P256SigningKey.generate()
        val paired = listOf(grant(root, "host-identifier-000001", hostKey))
        val enrollment = AcceptedAccountEnrollment.root(root, hubURL, accountID, paired)
        assertEquals(1, enrollment.authority.sequence)
        assertTrue(enrollment.roster.roster.devices.any { it.publicKey == root.publicKeyEncoded && it.signer })
        assertEquals(listOf(EndorsedAccountHost("host-identifier-000001", hostKey.publicKeyEncoded)), enrollment.hosts)

        assertFailsWith<AccountRosterException> {
            AcceptedAccountEnrollment.root(root, hubURL, accountID, emptyList())
        }
    }

    @Test
    fun memberEnrollmentRoundTrips() {
        val hostKey = P256SigningKey.generate()
        val rootEnrollment = AcceptedAccountEnrollment.root(
            root,
            hubURL,
            accountID,
            listOf(grant(root, "host-identifier-000001", hostKey)),
        )
        val request = AccountEnrollmentRequest.create(member, hubURL, accountID, "Pixel")
        request.verify(hubURL, accountID)
        assertEquals(request, AccountEnrollmentRequest.decode(CanonicalJson.encodeBytes(request.toJson())))

        val approval = AccountEnrollmentApproval.approve(
            identity = root,
            request = request,
            hubURL = hubURL,
            current = rootEnrollment.roster,
            authority = rootEnrollment.authority,
            pairedHosts = rootEnrollment.hosts,
        )
        val accepted = approval.accept(request, trustedSignerKey = root.publicKeyEncoded)
        assertEquals(2, accepted.authority.sequence)
        assertTrue(accepted.roster.roster.devices.any { it.publicKey == member.publicKeyEncoded })
        assertEquals(rootEnrollment.hosts, accepted.hosts)
        assertNotNull(AccountEnrollmentApproval.decode(CanonicalJson.encodeBytes(approval.toJson())))

        // A member that is not in the accepted roster is rejected.
        val outsider = AccountEnrollmentRequest.create(P256SigningKey.generate(), hubURL, accountID, "Other")
        assertFailsWith<AccountRosterException> { approval.accept(outsider, root.publicKeyEncoded) }
    }

    @Test
    fun approvalRequiresTheSigningRoot() {
        val hostKey = P256SigningKey.generate()
        val rootEnrollment = AcceptedAccountEnrollment.root(
            root,
            hubURL,
            accountID,
            listOf(grant(root, "host-identifier-000001", hostKey)),
        )
        val request = AccountEnrollmentRequest.create(member, hubURL, accountID, "Pixel")
        assertFailsWith<AccountRosterException> {
            AccountEnrollmentApproval.approve(member, request, hubURL, rootEnrollment.roster, rootEnrollment.authority, rootEnrollment.hosts)
        }
    }

    @Test
    fun storePersistsAndRejectsForks() {
        kotlinx.coroutines.runBlocking {
            val directory = kotlin.io.path.createTempDirectory("miao-enrollment").toFile()
            val hostKey = P256SigningKey.generate()
            val enrollment = AcceptedAccountEnrollment.root(
                root,
                hubURL,
                accountID,
                listOf(grant(root, "host-identifier-000001", hostKey)),
            )
            val store = AccountEnrollmentStore(directory, root.publicKeyEncoded)
            store.accept(enrollment)
            assertEquals(enrollment, AccountEnrollmentStore(directory, root.publicKeyEncoded).account(hubURL, accountID))

            val old = enrollment.copy(
                roster = SignedAccountRoster.sign(
                    root,
                    AccountRosterPayload(accountID, 1, 1_700_000_000_000, enrollment.roster.roster.devices),
                ).let { roster ->
                    // Same sequence with a different digest is a fork.
                    SignedAccountRoster.sign(root, AccountRosterPayload(accountID, 1, 1_700_000_000_001, roster.roster.devices))
                },
            )
            assertFailsWith<AccountRosterException> { store.accept(old) }
        }
    }
}
