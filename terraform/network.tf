# ──────────── VPC ─────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block         = var.vpc_cidr
  enable_dns_support = true

  tags = merge(local.tags, { Name = "${local.name_prefix}-vpc" })
}

# ──────────── Subnets ─────────────────────────────────────────────────────────

resource "aws_subnet" "public" {
  for_each = var.availability_zones

  vpc_id                  = aws_vpc.main.id
  cidr_block              = each.key == "az1" ? "10.0.2.0/24" : "10.0.4.0/24"
  availability_zone       = each.value
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${local.name_prefix}-subnet-${each.key}-public" })
}

resource "aws_subnet" "private" {
  for_each = var.availability_zones

  vpc_id                  = aws_vpc.main.id
  cidr_block              = each.key == "az1" ? "10.0.1.0/24" : "10.0.3.0/24"
  availability_zone       = each.value
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Name = "${local.name_prefix}-subnet-${each.key}-private" })
}

# ──────────── Internet Gateway ────────────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "${local.name_prefix}-internet-gateway" })
}

# ──────────── Route Tables ────────────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "${local.name_prefix}-route-table-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "${local.name_prefix}-route-table-private" })
}

# ──────────── Route Table Associations ────────────────────────────────────────

resource "aws_route_table_association" "public" {
  for_each = var.availability_zones

  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each = var.availability_zones

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private.id
}