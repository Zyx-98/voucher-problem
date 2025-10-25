CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

DROP MATERIALIZED VIEW IF EXISTS voucher_stats CASCADE;
DROP VIEW IF EXISTS user_voucher_summary CASCADE;
DROP VIEW IF EXISTS daily_claim_stats CASCADE;

DROP TRIGGER IF EXISTS enforce_voucher_limit ON users;
DROP TRIGGER IF EXISTS update_users_timestamp ON users;
DROP TRIGGER IF EXISTS update_voucher_codes_timestamp ON voucher_codes;
DROP TRIGGER IF EXISTS log_voucher_claim ON voucher_claims;
DROP TRIGGER IF EXISTS increment_voucher_usage ON voucher_codes;

DROP FUNCTION IF EXISTS check_voucher_limit() CASCADE;
DROP FUNCTION IF EXISTS update_timestamp() CASCADE;
DROP FUNCTION IF EXISTS log_claim_to_audit() CASCADE;
DROP FUNCTION IF EXISTS increment_voucher_code_usage() CASCADE;
DROP FUNCTION IF EXISTS refresh_voucher_stats() CASCADE;
DROP FUNCTION IF EXISTS get_user_claim_rate(INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS detect_suspicious_activity(INTEGER) CASCADE;

DROP TABLE IF EXISTS voucher_audit_log CASCADE;
DROP TABLE IF EXISTS voucher_claims CASCADE;
DROP TABLE IF EXISTS voucher_codes CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS blacklisted_tokens CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP TYPE IF EXISTS voucher_status CASCADE;
DROP TYPE IF EXISTS audit_action CASCADE;


CREATE TYPE voucher_status AS ENUM ('pending', 'success', 'failed', 'refunded');
CREATE TYPE audit_action AS ENUM (
    'CLAIM_SUCCESS', 
    'CLAIM_DENIED', 
    'LIMIT_REACHED', 
    'REFUND', 
    'CODE_CREATED',
    'CODE_DEACTIVATED',
    'SUSPICIOUS_ACTIVITY'
);

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    vouchers_claimed INTEGER DEFAULT 0 NOT NULL,
    voucher_limit INTEGER DEFAULT 10 NOT NULL,
    is_premium BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    phone VARCHAR(20),
    phone_verified BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    last_login TIMESTAMP,
    CONSTRAINT check_vouchers_non_negative CHECK (vouchers_claimed >= 0),
    CONSTRAINT check_limit_positive CHECK (voucher_limit > 0),
    CONSTRAINT check_vouchers_not_exceed_limit CHECK (vouchers_claimed <= voucher_limit),
    CONSTRAINT check_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_is_premium ON users(is_premium) WHERE is_premium = TRUE;
CREATE INDEX idx_users_is_active ON users(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_users_created_at ON users(created_at DESC);
CREATE INDEX idx_users_last_login ON users(last_login DESC) WHERE last_login IS NOT NULL;
CREATE INDEX idx_users_email_trgm ON users USING gin (email gin_trgm_ops); -- For fuzzy search

COMMENT ON TABLE users IS 'Stores user account information and voucher claim tracking';
COMMENT ON COLUMN users.vouchers_claimed IS 'Current number of vouchers claimed by user';
COMMENT ON COLUMN users.voucher_limit IS 'Maximum number of vouchers user can claim';
COMMENT ON COLUMN users.is_premium IS 'Premium users get priority processing';
COMMENT ON COLUMN users.metadata IS 'Additional user data in JSON format';

CREATE TABLE voucher_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_used BOOLEAN DEFAULT FALSE,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TIMESTAMP,
    usage_limit INTEGER DEFAULT 1 NOT NULL,
    usage_count INTEGER DEFAULT 0 NOT NULL,
    valid_from TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    discount_type VARCHAR(20) CHECK (discount_type IN ('percentage', 'fixed', 'free_shipping')),
    discount_value DECIMAL(10, 2),
    min_purchase_amount DECIMAL(10, 2) DEFAULT 0,
    max_discount_amount DECIMAL(10, 2),
    user_segment VARCHAR(50),
    allowed_user_ids INTEGER[],
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT check_code_format CHECK (code ~* '^[A-Z0-9-]+$'),
    CONSTRAINT check_code_length CHECK (LENGTH(code) >= 6 AND LENGTH(code) <= 50),
    CONSTRAINT check_usage_count_not_negative CHECK (usage_count >= 0),
    CONSTRAINT check_usage_limit_positive CHECK (usage_limit > 0),
    CONSTRAINT check_usage_count_not_exceed_limit CHECK (usage_count <= usage_limit),
    CONSTRAINT check_valid_date_range CHECK (expires_at IS NULL OR valid_from < expires_at),
    CONSTRAINT check_discount_value_positive CHECK (discount_value IS NULL OR discount_value > 0),
    CONSTRAINT check_min_purchase_non_negative CHECK (min_purchase_amount >= 0)
);

CREATE INDEX idx_voucher_codes_code ON voucher_codes(code);
CREATE INDEX idx_voucher_codes_active ON voucher_codes(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_voucher_codes_active_unused ON voucher_codes(is_active, is_used) 
    WHERE is_active = TRUE AND is_used = FALSE;
CREATE INDEX idx_voucher_codes_expires ON voucher_codes(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_voucher_codes_used_by ON voucher_codes(used_by) WHERE used_by IS NOT NULL;
CREATE INDEX idx_voucher_codes_user_segment ON voucher_codes(user_segment) WHERE user_segment IS NOT NULL;
CREATE INDEX idx_voucher_codes_created_at ON voucher_codes(created_at DESC);

COMMENT ON TABLE voucher_codes IS 'Stores all available voucher codes and their properties';
COMMENT ON COLUMN voucher_codes.usage_limit IS 'Maximum number of times this code can be used (0 = unlimited)';
COMMENT ON COLUMN voucher_codes.usage_count IS 'Current number of times this code has been used';
COMMENT ON COLUMN voucher_codes.user_segment IS 'Target user segment for this voucher';
COMMENT ON COLUMN voucher_codes.allowed_user_ids IS 'Array of specific user IDs allowed to use this code';

CREATE TABLE voucher_claims (
    id SERIAL PRIMARY KEY,
    Core fields
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    voucher_code VARCHAR(50) NOT NULL,
    voucher_code_id INTEGER REFERENCES voucher_codes(id) ON DELETE SET NULL,
    status voucher_status DEFAULT 'success' NOT NULL,
    claimed_at TIMESTAMP DEFAULT NOW() NOT NULL,
    ip_address INET,
    user_agent TEXT,
    device_id VARCHAR(255),
    session_id VARCHAR(255),
    request_id UUID DEFAULT uuid_generate_v4(),
    refunded_at TIMESTAMP,
    refunded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    refund_reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT check_status_refund_consistency CHECK (
        (status = 'refunded' AND refunded_at IS NOT NULL) OR
        (status != 'refunded' AND refunded_at IS NULL)
    )
);

CREATE INDEX idx_voucher_claims_user_id ON voucher_claims(user_id);
CREATE INDEX idx_voucher_claims_voucher_code ON voucher_claims(voucher_code);
CREATE INDEX idx_voucher_claims_voucher_code_id ON voucher_claims(voucher_code_id);
CREATE INDEX idx_voucher_claims_claimed_at ON voucher_claims(claimed_at DESC);
CREATE INDEX idx_voucher_claims_status ON voucher_claims(status);
CREATE INDEX idx_voucher_claims_ip_address ON voucher_claims(ip_address);
CREATE INDEX idx_voucher_claims_device_id ON voucher_claims(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX idx_voucher_claims_request_id ON voucher_claims(request_id);
CREATE INDEX idx_voucher_claims_user_status ON voucher_claims(user_id, status);
CREATE INDEX idx_voucher_claims_user_date ON voucher_claims(user_id, claimed_at DESC);

CREATE INDEX idx_voucher_claims_fraud_detection 
    ON voucher_claims(ip_address, device_id, claimed_at DESC)
    WHERE status = 'success';

CREATE INDEX idx_voucher_claims_recent 
    ON voucher_claims(claimed_at DESC) 
    WHERE claimed_at >= NOW() - INTERVAL '7 days';

COMMENT ON TABLE voucher_claims IS 'Records all voucher claim attempts and results';
COMMENT ON COLUMN voucher_claims.request_id IS 'Unique identifier for idempotency';
COMMENT ON COLUMN voucher_claims.metadata IS 'Additional claim data (discount applied, order info, etc.)';

CREATE TABLE voucher_audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER,
    action audit_action NOT NULL,
    voucher_code VARCHAR(50),
    voucher_code_id INTEGER,
    claim_id INTEGER,
    ip_address INET,
    user_agent TEXT,
    device_id VARCHAR(255),
    session_id VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_voucher_code FOREIGN KEY (voucher_code_id) REFERENCES voucher_codes(id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_claim FOREIGN KEY (claim_id) REFERENCES voucher_claims(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_log_user_id ON voucher_audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON voucher_audit_log(action, created_at DESC);
CREATE INDEX idx_audit_log_voucher_code ON voucher_audit_log(voucher_code);
CREATE INDEX idx_audit_log_ip_address ON voucher_audit_log(ip_address, created_at DESC);
CREATE INDEX idx_audit_log_device_id ON voucher_audit_log(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX idx_audit_log_created_at ON voucher_audit_log(created_at DESC);

-- Partitioning by month (for large-scale systems)
-- CREATE TABLE voucher_audit_log_y2024m01 PARTITION OF voucher_audit_log
--     FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

COMMENT ON TABLE voucher_audit_log IS 'Complete audit trail of all voucher system actions';
COMMENT ON COLUMN voucher_audit_log.metadata IS 'Additional context about the action';

CREATE TABLE user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    refresh_token VARCHAR(255) UNIQUE,
    ip_address INET,
    user_agent TEXT,
    device_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    last_activity TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    CONSTRAINT check_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_session_token ON user_sessions(session_token);
CREATE INDEX idx_user_sessions_refresh_token ON user_sessions(refresh_token);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_sessions_active ON user_sessions(user_id, is_active) WHERE is_active = TRUE;

COMMENT ON TABLE user_sessions IS 'Tracks active user sessions for authentication';

CREATE TABLE blacklisted_tokens (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    blacklisted_at TIMESTAMP DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    reason VARCHAR(100)
);

CREATE INDEX idx_blacklisted_tokens_hash ON blacklisted_tokens(token_hash);
CREATE INDEX idx_blacklisted_tokens_expires ON blacklisted_tokens(expires_at);
CREATE INDEX idx_blacklisted_tokens_user ON blacklisted_tokens(user_id);

COMMENT ON TABLE blacklisted_tokens IS 'Stores invalidated JWT tokens for logout';

-- Function: Update timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_timestamp() IS 'Automatically updates the updated_at timestamp';

-- Function: Check voucher limit
CREATE OR REPLACE FUNCTION check_voucher_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.vouchers_claimed > NEW.voucher_limit THEN
        RAISE EXCEPTION 'Voucher limit exceeded for user %', NEW.id
            USING ERRCODE = 'check_violation',
                  HINT = 'User has reached maximum voucher limit';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_voucher_limit() IS 'Enforces voucher limit constraints';

-- Function: Log claim to audit
CREATE OR REPLACE FUNCTION log_claim_to_audit()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO voucher_audit_log (
        user_id, 
        action, 
        voucher_code, 
        voucher_code_id,
        claim_id,
        ip_address, 
        user_agent, 
        device_id,
        metadata
    ) VALUES (
        NEW.user_id,
        CASE NEW.status
            WHEN 'success' THEN 'CLAIM_SUCCESS'::audit_action
            WHEN 'failed' THEN 'CLAIM_DENIED'::audit_action
            ELSE 'CLAIM_DENIED'::audit_action
        END,
        NEW.voucher_code,
        NEW.voucher_code_id,
        NEW.id,
        NEW.ip_address,
        NEW.user_agent,
        NEW.device_id,
        NEW.metadata
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION log_claim_to_audit() IS 'Automatically logs voucher claims to audit table';

-- Function: Increment voucher code usage
CREATE OR REPLACE FUNCTION increment_voucher_code_usage()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'success' AND NEW.voucher_code_id IS NOT NULL THEN
        UPDATE voucher_codes
        SET 
            usage_count = usage_count + 1,
            is_used = CASE 
                WHEN usage_count + 1 >= usage_limit THEN TRUE 
                ELSE is_used 
            END,
            updated_at = NOW()
        WHERE id = NEW.voucher_code_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION increment_voucher_code_usage() IS 'Increments usage count when voucher is claimed';

-- Function: Get user claim rate
CREATE OR REPLACE FUNCTION get_user_claim_rate(
    p_user_id INTEGER,
    p_minutes INTEGER DEFAULT 60
)
RETURNS INTEGER AS $$
DECLARE
    claim_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO claim_count
    FROM voucher_claims
    WHERE user_id = p_user_id
        AND claimed_at >= NOW() - (p_minutes || ' minutes')::INTERVAL;
    
    RETURN claim_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_user_claim_rate(INTEGER, INTEGER) IS 'Returns number of claims by user in specified time window';

-- Function: Detect suspicious activity
CREATE OR REPLACE FUNCTION detect_suspicious_activity(p_user_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
    recent_claims INTEGER;
    ip_count INTEGER;
    device_count INTEGER;
BEGIN
    -- Check for rapid claims (>5 in 10 minutes)
    SELECT COUNT(*) INTO recent_claims
    FROM voucher_claims
    WHERE user_id = p_user_id
        AND claimed_at >= NOW() - INTERVAL '10 minutes';
    
    IF recent_claims > 5 THEN
        RETURN TRUE;
    END IF;
    
    -- Check for multiple IPs in last hour
    SELECT COUNT(DISTINCT ip_address) INTO ip_count
    FROM voucher_claims
    WHERE user_id = p_user_id
        AND claimed_at >= NOW() - INTERVAL '1 hour';
    
    IF ip_count > 3 THEN
        RETURN TRUE;
    END IF;
    
    -- Check for multiple devices in last hour
    SELECT COUNT(DISTINCT device_id) INTO device_count
    FROM voucher_claims
    WHERE user_id = p_user_id
        AND device_id IS NOT NULL
        AND claimed_at >= NOW() - INTERVAL '1 hour';
    
    IF device_count > 3 THEN
        RETURN TRUE;
    END IF;
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION detect_suspicious_activity(INTEGER) IS 'Detects potentially fraudulent user behavior';

-- Function: Refresh materialized view
CREATE OR REPLACE FUNCTION refresh_voucher_stats()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY voucher_stats;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_voucher_stats() IS 'Refreshes the voucher statistics materialized view';

-- Trigger: Update users timestamp
CREATE TRIGGER update_users_timestamp
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Trigger: Enforce voucher limit
CREATE TRIGGER enforce_voucher_limit
    BEFORE UPDATE ON users
    FOR EACH ROW
    WHEN (NEW.vouchers_claimed <> OLD.vouchers_claimed)
    EXECUTE FUNCTION check_voucher_limit();

-- Trigger: Update voucher_codes timestamp
CREATE TRIGGER update_voucher_codes_timestamp
    BEFORE UPDATE ON voucher_codes
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Trigger: Log voucher claim
CREATE TRIGGER log_voucher_claim
    AFTER INSERT ON voucher_claims
    FOR EACH ROW
    EXECUTE FUNCTION log_claim_to_audit();

-- Trigger: Increment voucher usage
CREATE TRIGGER increment_voucher_usage
    AFTER INSERT ON voucher_claims
    FOR EACH ROW
    EXECUTE FUNCTION increment_voucher_code_usage();


-- View: User voucher summary
CREATE OR REPLACE VIEW user_voucher_summary AS
SELECT 
    u.id,
    u.email,
    u.is_premium,
    u.vouchers_claimed,
    u.voucher_limit,
    u.voucher_limit - u.vouchers_claimed AS vouchers_remaining,
    ROUND((u.vouchers_claimed::DECIMAL / NULLIF(u.voucher_limit, 0)) * 100, 2) AS usage_percentage,
    COUNT(vc.id) AS total_claims,
    COUNT(vc.id) FILTER (WHERE vc.status = 'success') AS successful_claims,
    COUNT(vc.id) FILTER (WHERE vc.status = 'refunded') AS refunded_claims,
    MAX(vc.claimed_at) AS last_claim_at,
    u.created_at,
    u.last_login
FROM users u
LEFT JOIN voucher_claims vc ON u.id = vc.user_id
GROUP BY u.id, u.email, u.is_premium, u.vouchers_claimed, u.voucher_limit, u.created_at, u.last_login;

COMMENT ON VIEW user_voucher_summary IS 'Comprehensive user voucher usage summary';

-- View: Daily claim statistics
CREATE OR REPLACE VIEW daily_claim_stats AS
SELECT 
    DATE(claimed_at) AS claim_date,
    COUNT(*) AS total_claims,
    COUNT(DISTINCT user_id) AS unique_users,
    COUNT(*) FILTER (WHERE status = 'success') AS successful_claims,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_claims,
    COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_claims,
    COUNT(DISTINCT voucher_code) AS unique_codes_used,
    ROUND(AVG(EXTRACT(EPOCH FROM (claimed_at - LAG(claimed_at) OVER (ORDER BY claimed_at)))), 2) AS avg_seconds_between_claims
FROM voucher_claims
WHERE claimed_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(claimed_at)
ORDER BY claim_date DESC;

COMMENT ON VIEW daily_claim_stats IS 'Daily aggregated voucher claim statistics';

-- ============================================================================
-- MATERIALIZED VIEWS
-- ============================================================================

-- Materialized View: Voucher statistics (for fast analytics)
CREATE MATERIALIZED VIEW voucher_stats AS
SELECT 
    DATE_TRUNC('hour', claimed_at) AS hour,
    COUNT(*) AS total_claims,
    COUNT(DISTINCT user_id) AS unique_users,
    COUNT(*) FILTER (WHERE status = 'success') AS successful_claims,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_claims,
    COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_claims,
    COUNT(DISTINCT ip_address) AS unique_ips,
    COUNT(DISTINCT device_id) AS unique_devices,
    ROUND(AVG(EXTRACT(EPOCH FROM (claimed_at - LAG(claimed_at) OVER (ORDER BY claimed_at)))), 2) AS avg_seconds_between_claims
FROM voucher_claims
WHERE claimed_at >= NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', claimed_at)
ORDER BY hour DESC;

-- Create unique index for concurrent refresh
CREATE UNIQUE INDEX idx_voucher_stats_hour ON voucher_stats(hour);

COMMENT ON MATERIALIZED VIEW voucher_stats IS 'Hourly aggregated voucher statistics for the last 7 days';

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Insert sample users
INSERT INTO users (email, password_hash, vouchers_claimed, voucher_limit, is_premium, is_admin, email_verified) VALUES
    ('admin@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 0, 100, TRUE, TRUE, TRUE),
    ('premium@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 5, 50, TRUE, FALSE, TRUE),
    ('user1@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 0, 10, FALSE, FALSE, TRUE),
    ('user2@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 5, 10, FALSE, FALSE, TRUE),
    ('user3@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 9, 10, FALSE, FALSE, TRUE),
    ('newuser@example.com', '$2b$10$rGHQxZ8Z8Z8Z8Z8Z8Z8Z8O', 0, 10, FALSE, FALSE, FALSE)
ON CONFLICT (email) DO NOTHING;

-- Insert sample voucher codes
INSERT INTO voucher_codes (
    code, 
    is_active, 
    expires_at, 
    usage_limit, 
    discount_type, 
    discount_value,
    min_purchase_amount,
    description,
    user_segment
) VALUES
    ('SUMMER2024', TRUE, NOW() + INTERVAL '30 days', 1000, 'percentage', 20.00, 50.00, 'Summer Sale - 20% off', 'all'),
    ('WINTER2024', TRUE, NOW() + INTERVAL '60 days', 500, 'percentage', 15.00, 30.00, 'Winter Special - 15% off', 'all'),
    ('WELCOME10', TRUE, NOW() + INTERVAL '90 days', 10000, 'percentage', 10.00, 0.00, 'Welcome discount for new users', 'new'),
    ('PREMIUM50', TRUE, NOW() + INTERVAL '90 days', 100, 'fixed', 50.00, 100.00, 'Premium members exclusive', 'premium'),
    ('FREESHIP', TRUE, NOW() + INTERVAL '45 days', 2000, 'free_shipping', 0.00, 25.00, 'Free shipping on orders above $25', 'all'),
    ('SPECIAL100', TRUE, NOW() + INTERVAL '15 days', 50, 'fixed', 100.00, 500.00, 'Limited time - $100 off', 'all'),
    ('FLASH20', TRUE, NOW() + INTERVAL '1 day', 100, 'percentage', 20.00, 100.00, 'Flash sale - 24 hours only', 'all'),
    ('EXPIRED2023', TRUE, NOW() - INTERVAL '30 days', 1000, 'percentage', 15.00, 50.00, 'Expired code for testing', 'all')
ON CONFLICT (code) DO NOTHING;

-- Insert sample voucher claims (for testing)
INSERT INTO voucher_claims (
    user_id, 
    voucher_code, 
    voucher_code_id,
    status, 
    ip_address, 
    user_agent,
    claimed_at
)
SELECT 
    u.id,
    vc.code,
    vc.id,
    'success'::voucher_status,
    '192.168.1.' || (random() * 255)::integer::text,
    'Mozilla/5.0 (Test User Agent)',
    NOW() - (random() * INTERVAL '7 days')
FROM users u
CROSS JOIN voucher_codes vc
WHERE u.email IN ('user2@example.com', 'premium@example.com')
    AND vc.code IN ('SUMMER2024', 'WELCOME10')
LIMIT 10
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PERFORMANCE OPTIMIZATION
-- ============================================================================

-- Analyze tables for query planner
ANALYZE users;
ANALYZE voucher_codes;
ANALYZE voucher_claims;
ANALYZE voucher_audit_log;

-- Vacuum tables
VACUUM ANALYZE users;
VACUUM ANALYZE voucher_codes;
VACUUM ANALYZE voucher_claims;

-- ============================================================================
-- SECURITY & PERMISSIONS
-- ============================================================================

-- Create application role (in production)
-- CREATE ROLE voucher_app WITH LOGIN PASSWORD 'secure_password';
-- GRANT SELECT, INSERT, UPDATE ON users TO voucher_app;
-- GRANT SELECT, INSERT, UPDATE ON voucher_codes TO voucher_app;
-- GRANT SELECT, INSERT ON voucher_claims TO voucher_app;
-- GRANT SELECT, INSERT ON voucher_audit_log TO voucher_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO voucher_app;

-- Create read-only role for analytics
-- CREATE ROLE voucher_readonly WITH LOGIN PASSWORD 'readonly_password';
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO voucher_readonly;

-- ============================================================================
-- MONITORING QUERIES (for reference)
-- ============================================================================

-- Check database size
-- SELECT pg_size_pretty(pg_database_size(current_database()));

-- Check table sizes
-- SELECT 
--     schemaname,
--     tablename,
--     pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
-- SELECT 
--     schemaname,
--     tablename,
--     indexname,
--     idx_scan,
--     idx_tup_read,
--     idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
-- ORDER BY idx_scan DESC;

-- Check slow queries (requires pg_stat_statements extension)
-- SELECT 
--     query,
--     calls,
--     total_time,
--     mean_time,
--     max_time
-- FROM pg_stat_statements
-- ORDER BY mean_time DESC
-- LIMIT 10;

-- ============================================================================
-- MAINTENANCE QUERIES
-- ============================================================================

-- Clean up expired voucher codes
-- UPDATE voucher_codes 
-- SET is_active = FALSE 
-- WHERE expires_at < NOW() AND is_active = TRUE;

-- Clean up old sessions
-- DELETE FROM user_sessions 
-- WHERE expires_at < NOW() OR (last_activity < NOW() - INTERVAL '7 days');

-- Clean up old blacklisted tokens
-- DELETE FROM blacklisted_tokens WHERE expires_at < NOW();

-- Refresh materialized views (run periodically)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY voucher_stats;

-- ============================================================================
-- BACKUP & RESTORE NOTES
-- ============================================================================

-- Backup command:
-- pg_dump -h localhost -U postgres -d voucher_system -F c -f voucher_system_backup.dump

-- Restore command:
-- pg_restore -h localhost -U postgres -d voucher_system -c voucher_system_backup.dump

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================

-- Success message
DO $$
BEGIN
    RAISE NOTICE '=================================================';
    RAISE NOTICE 'Voucher System Database Schema Created Successfully';
    RAISE NOTICE '=================================================';
    RAISE NOTICE 'Tables created: 6';
    RAISE NOTICE 'Views created: 3';
    RAISE NOTICE 'Functions created: 6';
    RAISE NOTICE 'Triggers created: 5';
    RAISE NOTICE '=================================================';
END $$;