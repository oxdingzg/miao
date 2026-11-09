package dev.miao.core

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class MalformedMaterialException : Exception("malformed cryptographic material")
class InvalidSignatureException : Exception("invalid signature")

/** Affine P-256 arithmetic for public-key derivation and point validation. */
object P256Curve {
    val p = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    val fieldA = p - BigInteger.valueOf(3)
    val coefficientB = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    val order = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

    data class Point(val x: BigInteger, val y: BigInteger)

    val generator = Point(
        BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16),
        BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16),
    )

    fun isOnCurve(point: Point): Boolean {
        if (point.x.signum() < 0 || point.x >= p || point.y.signum() < 0 || point.y >= p) return false
        val left = point.y.multiply(point.y).mod(p)
        val right = point.x.modPow(BigInteger.valueOf(3), p)
            .add(fieldA.multiply(point.x))
            .add(coefficientB)
            .mod(p)
        return left == right
    }

    fun multiply(point: Point, scalar: BigInteger): Point {
        var result: Point? = null
        var addend = point
        var remaining = scalar
        while (remaining.signum() > 0) {
            if (remaining.testBit(0)) result = result?.let { add(it, addend) } ?: addend
            addend = add(addend, addend)
            remaining = remaining.shiftRight(1)
        }
        return result ?: throw MalformedMaterialException()
    }

    private fun add(first: Point, second: Point): Point {
        if (first.x == second.x) {
            if (first.y != second.y || first.y.signum() == 0) throw MalformedMaterialException()
            val slope = first.x.multiply(first.x).multiply(BigInteger.valueOf(3)).add(fieldA)
                .multiply(first.y.shiftLeft(1).modInverse(p))
            return finish(first, first.x, slope)
        }
        val slope = second.y.subtract(first.y).multiply(second.x.subtract(first.x).modInverse(p))
        return finish(first, second.x, slope)
    }

    private fun finish(from: Point, otherX: BigInteger, slope: BigInteger): Point {
        val x = slope.multiply(slope).subtract(from.x).subtract(otherX).mod(p)
        val y = slope.multiply(from.x.subtract(x)).subtract(from.y).mod(p)
        return Point(x, y)
    }

    fun scalar(raw: ByteArray): BigInteger {
        val value = BigInteger(1, raw)
        if (value.signum() <= 0 || value >= order) throw MalformedMaterialException()
        return value
    }
}

object Crypto {
    private val random = SecureRandom()
    private val parameters: ECParameterSpec by lazy {
        val algorithm = AlgorithmParameters.getInstance("EC")
        algorithm.init(ECGenParameterSpec("secp256r1"))
        algorithm.getParameterSpec(ECParameterSpec::class.java)
    }

    fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    fun sha256(data: ByteArray): ByteArray = java.security.MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSHA256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** RFC 5869 HKDF with SHA-256. */
    fun hkdfSHA256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32))
        val pseudoRandomKey = hmacSHA256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val block = hmacSHA256(pseudoRandomKey, previous + info + byteArrayOf(counter.toByte()))
            val take = minOf(block.size, length - offset)
            block.copyInto(output, offset, 0, take)
            previous = block
            offset += take
            counter++
        }
        return output
    }

    /** AES-256-GCM: returns ciphertext followed by the 16-byte tag. */
    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ciphertextAndTag: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertextAndTag)
    }

    fun publicKeyFor(raw: ByteArray): ByteArray {
        val point = P256Curve.multiply(P256Curve.generator, P256Curve.scalar(raw))
        return x963(point)
    }

    fun pointOf(x963: ByteArray): P256Curve.Point {
        if (x963.size != 65 || x963[0] != 4.toByte()) throw MalformedMaterialException()
        val point = P256Curve.Point(
            BigInteger(1, x963.copyOfRange(1, 33)),
            BigInteger(1, x963.copyOfRange(33, 65)),
        )
        if (!P256Curve.isOnCurve(point)) throw MalformedMaterialException()
        return point
    }

    fun x963(point: P256Curve.Point): ByteArray =
        byteArrayOf(4) + point.x.toFixed(32) + point.y.toFixed(32)

    fun ecPublicKey(x963: ByteArray): ECPublicKey {
        val point = pointOf(x963)
        val spec = ECPublicKeySpec(ECPoint(point.x, point.y), parameters)
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }

    fun ecPrivateKey(raw: ByteArray): ECPrivateKey {
        val spec = ECPrivateKeySpec(P256Curve.scalar(raw), parameters)
        return KeyFactory.getInstance("EC").generatePrivate(spec) as ECPrivateKey
    }

    fun randomScalar(): ByteArray {
        while (true) {
            val raw = randomBytes(32)
            val value = BigInteger(1, raw)
            if (value.signum() > 0 && value < P256Curve.order) return raw
        }
    }

    fun ecdh(privateKey: ByteArray, peerX963: ByteArray): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(ecPrivateKey(privateKey))
        agreement.doPhase(ecPublicKey(peerX963), true)
        return agreement.generateSecret()
    }

    fun sign(privateKey: ByteArray, data: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(ecPrivateKey(privateKey))
        signature.update(data)
        val (r, s) = parseDer(signature.sign())
        return r.toFixed(32) + s.toFixed(32)
    }

    fun verify(publicKeyX963: ByteArray, signature64: ByteArray, data: ByteArray): Boolean {
        if (signature64.size != 64) return false
        val r = BigInteger(1, signature64.copyOfRange(0, 32))
        val s = BigInteger(1, signature64.copyOfRange(32, 64))
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initVerify(ecPublicKey(publicKeyX963))
        signature.update(data)
        return signature.verify(encodeDer(r, s))
    }

    private fun parseDer(der: ByteArray): Pair<BigInteger, BigInteger> {
        var index = 0
        if (der.size < 8 || der[index++] != 0x30.toByte()) throw MalformedMaterialException()
        if (der[index].toInt() and 0x80 != 0) throw MalformedMaterialException()
        index++
        if (der[index++] != 0x02.toByte()) throw MalformedMaterialException()
        val rLength = der[index++].toInt()
        val r = BigInteger(1, der.copyOfRange(index, index + rLength))
        index += rLength
        if (der[index++] != 0x02.toByte()) throw MalformedMaterialException()
        val sLength = der[index++].toInt()
        val s = BigInteger(1, der.copyOfRange(index, index + sLength))
        return r to s
    }

    private fun encodeDer(r: BigInteger, s: BigInteger): ByteArray {
        val rBytes = r.toByteArray().trimLeading()
        val sBytes = s.toByteArray().trimLeading()
        val body = byteArrayOf(0x02, rBytes.size.toByte()) + rBytes + byteArrayOf(0x02, sBytes.size.toByte()) + sBytes
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun BigInteger.toFixed(size: Int): ByteArray {
        val bytes = toByteArray().trimLeading()
        if (bytes.size > size) throw MalformedMaterialException()
        return ByteArray(size - bytes.size) + bytes
    }

    private fun ByteArray.trimLeading(): ByteArray {
        var start = 0
        while (start < size - 1 && this[start] == 0.toByte()) start++
        return copyOfRange(start, size)
    }
}

class P256SigningKey(raw: ByteArray) {
    val raw: ByteArray = raw.copyOf()
    val publicKey: ByteArray = Crypto.publicKeyFor(raw)

    fun sign(data: ByteArray): ByteArray = Crypto.sign(raw, data)

    val publicKeyEncoded: String get() = BinaryEncoding.encode(publicKey)

    companion object {
        fun generate(): P256SigningKey = P256SigningKey(Crypto.randomScalar())

        fun fromEncoded(raw: ByteArray): P256SigningKey {
            if (raw.size != 32) throw MalformedMaterialException()
            return P256SigningKey(raw)
        }
    }
}

class P256AgreementKey(raw: ByteArray) {
    private val raw: ByteArray = raw.copyOf()
    val publicKey: ByteArray = Crypto.publicKeyFor(raw)

    fun secret(peerX963: ByteArray): ByteArray = Crypto.ecdh(raw, peerX963)
    fun encodedPublicKey(): String = BinaryEncoding.encode(publicKey)

    companion object {
        fun generate(): P256AgreementKey = P256AgreementKey(Crypto.randomScalar())
    }
}
