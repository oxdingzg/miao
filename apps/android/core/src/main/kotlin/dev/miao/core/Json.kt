package dev.miao.core

import java.math.BigDecimal
import java.util.Base64

/** Immutable JSON tree. Numbers keep their wire text so canonical re-serialization is stable. */
sealed class JsonValue {
    data object Null : JsonValue()
    data class Bool(val value: Boolean) : JsonValue()
    data class Number(val token: String) : JsonValue() {
        fun toLongOrNull(): Long? = token.toLongOrNull() ?: runCatching { BigDecimal(token).longValueExact() }.getOrNull()
        fun toDouble(): Double = token.toDouble()
    }

    data class Str(val value: String) : JsonValue()
    data class Arr(val values: List<JsonValue>) : JsonValue()
    data class Obj(val entries: Map<String, JsonValue>) : JsonValue()

    operator fun get(key: String): JsonValue? = (this as? Obj)?.entries?.get(key)
    val string: String? get() = (this as? Str)?.value
    val array: List<JsonValue>? get() = (this as? Arr)?.values
    val bool: Boolean? get() = (this as? Bool)?.value
    val objectMap: Map<String, JsonValue>? get() = (this as? Obj)?.entries
    val number: Double? get() = (this as? Number)?.toDouble()
    val long: Long? get() = (this as? Number)?.toLongOrNull()

    companion object {
        fun of(value: Long): JsonValue = Number(value.toString())
        fun of(value: Int): JsonValue = Number(value.toString())
        fun of(value: Boolean): JsonValue = Bool(value)
        fun of(value: String): JsonValue = Str(value)
        fun of(value: List<JsonValue>): JsonValue = Arr(value)
        fun obj(vararg entries: Pair<String, JsonValue>): JsonValue = Obj(linkedMapOf(*entries))
    }
}

class JsonParseException(message: String) : Exception(message)

/**
 * Canonical JSON matches the TypeScript peer: `JSON.stringify` of an object whose
 * keys are sorted by UTF-16 code unit, no whitespace, slashes unescaped, control
 * characters as lowercase `\uXXXX`, and integral numbers without a fraction.
 */
object CanonicalJson {
    fun encode(value: JsonValue): String = buildString { write(value) }

    fun encodeBytes(value: JsonValue): ByteArray = encode(value).toByteArray(Charsets.UTF_8)

    fun parse(bytes: ByteArray): JsonValue = parse(String(bytes, Charsets.UTF_8))

    fun parse(text: String): JsonValue = Parser(text).parseDocument()

    private fun StringBuilder.write(value: JsonValue) {
        when (value) {
            JsonValue.Null -> append("null")
            is JsonValue.Bool -> append(if (value.value) "true" else "false")
            is JsonValue.Number -> append(value.token)
            is JsonValue.Str -> writeString(value.value)
            is JsonValue.Arr -> {
                append('[')
                value.values.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    write(item)
                }
                append(']')
            }
            is JsonValue.Obj -> {
                append('{')
                val keys = value.entries.keys.sortedWith(::compareCodeUnits)
                keys.forEachIndexed { index, key ->
                    if (index > 0) append(',')
                    writeString(key)
                    append(':')
                    write(value.entries.getValue(key))
                }
                append('}')
            }
        }
    }

    private fun StringBuilder.writeString(text: String) {
        append('"')
        for (char in text) {
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else ->
                    if (char < ' ') append("\\u" + char.code.toString(16).padStart(4, '0'))
                    else append(char)
            }
        }
        append('"')
    }

    private fun compareCodeUnits(left: String, right: String): Int {
        val limit = minOf(left.length, right.length)
        for (index in 0 until limit) {
            val difference = left[index].code - right[index].code
            if (difference != 0) return difference
        }
        return left.length - right.length
    }

    private class Parser(private val text: String) {
        private var position = 0

        fun parseDocument(): JsonValue {
            val value = parseValue()
            skipWhitespace()
            if (position != text.length) fail("trailing content")
            return value
        }

        private fun parseValue(): JsonValue {
            skipWhitespace()
            if (position >= text.length) fail("unexpected end")
            return when (text[position]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> JsonValue.Str(parseString())
                't' -> parseLiteral("true", JsonValue.Bool(true))
                'f' -> parseLiteral("false", JsonValue.Bool(false))
                'n' -> parseLiteral("null", JsonValue.Null)
                else -> parseNumber()
            }
        }

        private fun parseObject(): JsonValue {
            position++
            val entries = LinkedHashMap<String, JsonValue>()
            skipWhitespace()
            if (peek() == '}') {
                position++
                return JsonValue.Obj(entries)
            }
            while (true) {
                skipWhitespace()
                if (peek() != '"') fail("expected object key")
                val key = parseString()
                skipWhitespace()
                if (next() != ':') fail("expected colon")
                entries[key] = parseValue()
                skipWhitespace()
                when (next()) {
                    ',' -> continue
                    '}' -> return JsonValue.Obj(entries)
                    else -> fail("expected comma or brace")
                }
            }
        }

        private fun parseArray(): JsonValue {
            position++
            val values = ArrayList<JsonValue>()
            skipWhitespace()
            if (peek() == ']') {
                position++
                return JsonValue.Arr(values)
            }
            while (true) {
                values.add(parseValue())
                skipWhitespace()
                when (next()) {
                    ',' -> continue
                    ']' -> return JsonValue.Arr(values)
                    else -> fail("expected comma or bracket")
                }
            }
        }

        private fun parseString(): String {
            position++
            val builder = StringBuilder()
            while (true) {
                if (position >= text.length) fail("unterminated string")
                val char = text[position++]
                when {
                    char == '"' -> return builder.toString()
                    char == '\\' -> {
                        if (position >= text.length) fail("unterminated escape")
                        when (text[position++]) {
                            '"' -> builder.append('"')
                            '\\' -> builder.append('\\')
                            '/' -> builder.append('/')
                            'b' -> builder.append('\b')
                            'f' -> builder.append('\u000C')
                            'n' -> builder.append('\n')
                            'r' -> builder.append('\r')
                            't' -> builder.append('\t')
                            'u' -> {
                                if (position + 4 > text.length) fail("short unicode escape")
                                val code = text.substring(position, position + 4).toIntOrNull(16) ?: fail("bad unicode escape")
                                position += 4
                                builder.append(code.toChar())
                            }
                            else -> fail("bad escape")
                        }
                    }
                    char < ' ' -> fail("raw control character")
                    else -> builder.append(char)
                }
            }
        }

        private fun parseNumber(): JsonValue {
            val start = position
            if (peek() == '-') position++
            while (position < text.length && (text[position].isDigit() || text[position] in ".eE+-")) position++
            if (start == position) fail("unexpected token")
            return JsonValue.Number(normalizeNumber(text.substring(start, position)))
        }

        private fun parseLiteral(word: String, value: JsonValue): JsonValue {
            if (!text.startsWith(word, position)) fail("unexpected token")
            position += word.length
            return value
        }

        private fun skipWhitespace() {
            while (position < text.length && text[position] in " \t\n\r") position++
        }

        private fun peek(): Char = if (position < text.length) text[position] else '\u0000'

        private fun next(): Char {
            if (position >= text.length) fail("unexpected end")
            return text[position++]
        }

        private fun fail(message: String): Nothing = throw JsonParseException("$message at $position")
    }

    /** Peers emit `JSON.stringify` output, so integral values stay plain digits. */
    private fun normalizeNumber(token: String): String {
        if (token.none { it == '.' || it == 'e' || it == 'E' }) return token
        val decimal = try {
            BigDecimal(token)
        } catch (_: NumberFormatException) {
            throw JsonParseException("invalid number")
        }
        return if (decimal.stripTrailingZeros().scale() <= 0) {
            decimal.toBigInteger().toString()
        } else {
            decimal.stripTrailingZeros().toPlainString()
        }
    }
}

object BinaryEncoding {
    private val pattern = Regex("^[A-Za-z0-9_-]+$")

    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(value: String): ByteArray = decodeOrNull(value, null) ?: throw JsonParseException("invalid binary encoding")

    fun decode(value: String, length: Int): ByteArray =
        decodeOrNull(value, length) ?: throw JsonParseException("invalid binary encoding")

    fun decodeOrNull(value: String, length: Int?): ByteArray? {
        if (!pattern.matches(value)) return null
        val decoded = try {
            Base64.getUrlDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (encode(decoded) != value) return null
        if (length != null && decoded.size != length) return null
        return decoded
    }
}
