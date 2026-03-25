from neo4j import GraphDatabase
from typing import Optional, Dict, Any, List
import os
from dotenv import load_dotenv, find_dotenv

# 加载环境变量：支持从项目根目录查找 .env（避免从backend子目录运行时找不到）
_dotenv_path = find_dotenv(usecwd=True)
if _dotenv_path:
    load_dotenv(_dotenv_path)
else:
    # 没有找到 .env 时也继续运行，使用默认值/系统环境
    pass


# 允许的节点类型（只应用于Entity，不应用于State）
ALLOWED_NODE_TYPES = {
    "character": "Character",      # 角色
    "location": "Location",        # 地点
    "faction": "Faction",          # 势力/组织
    "event": "Event",              # 事件
    "item": "Item",                # 物品
    "relationship": "Relationship" # 关系（用于2跳边的中间节点）
}

# entity_id 中禁止使用的保留关键字（用于避免与 API 固定路径冲突）
RESERVED_ENTITY_IDS = {"states"}



class Neo4jClient:
    def __init__(self, uri: str, user: str, password: str):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self._ensure_constraints()

    def close(self):
        self.driver.close()

    def initialize_db_if_empty(self):
        """如果数据库为空，则插入初始化数据。解决 Warning 并提升新用户体验。"""
        with self.driver.session() as session:
            # 1. 检查是否存在任何 Entity 节点
            result = session.run("MATCH (e:Entity) RETURN count(e) as cnt")
            count = result.single()["cnt"]
            
            if count == 0:
                print(">>> WARNING: 数据库为空。正在初始化示例数据...")
                try:
                    from .seed_data import insert_demo_data_via_client
                    # 2. 通过业务方法写入示例数据（保证 ID 格式一致）
                    insert_demo_data_via_client(self)
                    print(">>> 初始化完成: 已创建示例节点。")
                except Exception as e:
                    import traceback
                    print(f">>> 初始化警告: 写入示例数据失败: {e}")
                    traceback.print_exc()

    # _insert_initial_data 已移除，逻辑迁移至 seed_data.py

    def _ensure_constraints(self):
        """确保数据库约束存在"""
        with self.driver.session() as session:
            # Entity的id必须唯一
            session.run("""
                CREATE CONSTRAINT entity_id_unique IF NOT EXISTS
                FOR (e:Entity) REQUIRE e.id IS UNIQUE
            """)
            # State的id必须唯一
            session.run("""
                CREATE CONSTRAINT state_id_unique IF NOT EXISTS
                FOR (s:State) REQUIRE s.id IS UNIQUE
            """)
            # State的entity_id索引（加速关系查找）
            session.run("""
                CREATE INDEX state_entity_id_index IF NOT EXISTS
                FOR (s:State) ON (s.entity_id)
            """)

    @staticmethod
    def _validate_no_double_underscore(value: str, field_name: str):
        """验证字符串中不包含双下划线，防止ID生成冲突"""
        if "__" in value:
            raise ValueError(f"{field_name} cannot contain double underscores ('__'): '{value}'")

    @staticmethod
    def _validate_entity_id(value: str):
        """校验 entity_id，除了基础格式外还要避免保留关键字"""
        Neo4jClient._validate_no_double_underscore(value, "entity_id")
        if value in RESERVED_ENTITY_IDS:
            raise ValueError(
                f"entity_id '{value}' is reserved for internal routes. "
                "Please choose a different identifier."
            )

    def create_entity(
        self,
        entity_id: str,
        node_type: str,
        name: str,
        content: str,
        task_description: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        创建新节点及其第一个State版本

        Args:
            entity_id: 节点ID（必填，由AI决定，必须唯一）
            node_type: 节点类型（必填，必须在ALLOWED_NODE_TYPES中）
            name: 节点名称
            content: 节点内容
            task_description: 任务描述

        Raises:
            ValueError: 如果entity_id已存在或node_type不合法

        Returns:
            {
                "entity_id": str,
                "state_id": str,
                "version": int
            }
        """
        # 验证entity_id格式与保留关键字
        self._validate_entity_id(entity_id)

        # 验证node_type
        if node_type not in ALLOWED_NODE_TYPES:
            raise ValueError(
                f"Invalid node_type '{node_type}'. "
                f"Allowed types: {list(ALLOWED_NODE_TYPES.keys())}"
            )

        with self.driver.session() as session:
            # 检查entity_id是否已存在
            existing = session.run(
                "MATCH (e:Entity {id: $entity_id}) RETURN e",
                entity_id=entity_id
            ).single()

            if existing:
                raise ValueError(f"Entity with id '{entity_id}' already exists")

            label = ALLOWED_NODE_TYPES[node_type]
            result = session.execute_write(
                self._create_entity_tx,
                entity_id,
                label,
                name,
                content,
                task_description
            )
            return result

    @staticmethod
    def _create_entity_tx(tx, entity_id: str, label: str, name: str, content: str, task_description: Optional[str]):
        state_id = f"{entity_id}_v1"
        # 动态构造带分类标签的Cypher查询
        query = f"""
        CREATE (e:Entity:{label} {{
            id: $entity_id,
            created_at: datetime()
        }})
        CREATE (s:State {{
            id: $state_id,
            entity_id: $entity_id,
            version: 1,
            name: $name,
            content: $content,
            created_at: datetime(),
            created_by: 'ai_agent',
            task_description: $task_description
        }})
        CREATE (e)-[:CURRENT {{time: datetime()}}]->(s)
        RETURN e.id as entity_id, s.id as state_id, s.version as version
        """
        result = tx.run(
            query,
            entity_id=entity_id,
            name=name,
            state_id=state_id,
            content=content,
            task_description=task_description
        )
        record = result.single()
        return {
            "entity_id": record["entity_id"],
            "state_id": record["state_id"],
            "version": record["version"]
        }

    def update_entity(
        self,
        entity_id: str,
        new_content: str,
        new_name: Optional[str] = None,
        new_inheritable: Optional[bool] = None,
        task_description: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        更新节点，创建新的State版本

        Args:
            entity_id: 节点ID
            new_content: 新的内容
            new_name: 新的名称（不提供则继承上一版本）
            new_inheritable: 新的可继承性（不提供则继承上一版本，仅对 relay state 有意义）
            task_description: 任务描述

        Returns:
            {
                "entity_id": str,
                "old_version": int,
                "new_version": int,
                "state_id": str
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(
                self._update_entity_tx,
                entity_id,
                new_content,
                new_name,
                new_inheritable,
                task_description
            )
            return result

    @staticmethod
    def _update_entity_tx(tx, entity_id: str, new_content: str, new_name: Optional[str], 
                          new_inheritable: Optional[bool], task_description: Optional[str]):
        # 1. 基于 entity_id 查询该 Entity 下所有 State，找到版本号最大的那个作为旧版本
        #    - 不再依赖 CURRENT 指针来判断“当前版本”，而是以 State.version 的最大值为准
        #    - 这样即使 CURRENT 出现异常（缺失 / 指向旧版本 / 多条），版本链仍然是自洽的
        get_current_query = """
        MATCH (e:Entity {id: $entity_id})
        MATCH (s:State {entity_id: $entity_id})
        WITH s
        ORDER BY s.version DESC
        LIMIT 1
        RETURN s.version as max_version,
               s.name as max_name,
               s.inheritable as max_inheritable,
               s.id as max_state_id
        """
        current_result = tx.run(get_current_query, entity_id=entity_id)
        current_record = current_result.single()

        if not current_record:
            raise ValueError(f"Entity {entity_id} not found")

        old_version = current_record["max_version"]
        # 这是当前已存在的最新版本 State 的 ID（作为新版本的 PREVIOUS 目标）
        old_state_id = current_record["max_state_id"]
        # 如果没有提供新值，继承旧值
        name_to_use = new_name if new_name is not None else current_record["max_name"]
        inheritable_to_use = new_inheritable if new_inheritable is not None else current_record["max_inheritable"]
        new_version = old_version + 1
        state_id = f"{entity_id}_v{new_version}"

        # 2. 创建新State并更新关系
        # 注意：
        # - 不自动迁移业务边，仅维护版本链和 CURRENT 指针
        # - 为了防止同一个 Entity 上出现多个 CURRENT 边，这里会先删除该 Entity
        #   目前所有的 CURRENT，再创建指向新 State 的唯一一条 CURRENT。
        update_query = """
        MATCH (e:Entity {id: $entity_id})
        MATCH (old_state:State {id: $old_state_id})
        OPTIONAL MATCH (e)-[old_curr:CURRENT]->(:State)
        WITH e, old_state, collect(old_curr) AS old_currs
        CREATE (new_state:State {
            id: $state_id,
            entity_id: $entity_id,
            version: $new_version,
            name: $name,
            content: $new_content,
            inheritable: $inheritable,
            created_at: datetime(),
            created_by: 'ai_agent',
            task_description: $task_description
        })
        CREATE (new_state)-[:PREVIOUS]->(old_state)
        // 删除该 Entity 上已有的所有 CURRENT 边（如果之前意外存在多个）
        FOREACH (c IN old_currs | DELETE c)
        CREATE (e)-[:CURRENT {time: datetime()}]->(new_state)
        
        RETURN $old_version as old_version, new_state.version as new_version, new_state.id as state_id
        """
        result = tx.run(
            update_query,
            entity_id=entity_id,
            old_state_id=old_state_id,
            state_id=state_id,
            new_version=new_version,
            name=name_to_use,
            new_content=new_content,
            inheritable=inheritable_to_use,
            task_description=task_description,
            old_version=old_version
        )
        record = result.single()

        return {
            "entity_id": entity_id,
            "old_version": record["old_version"],
            "new_version": record["new_version"],
            "state_id": record["state_id"]
        }

    def get_entity_info(
        self,
        entity_id: str,
        include_basic: bool = True,
        include_history: bool = False,
        include_edges: bool = False,
        include_children: bool = False
    ) -> Optional[Dict[str, Any]]:
        """
        获取实体信息（整合版）
        
        Args:
            entity_id: Entity节点ID
            include_basic: 是否包含基本信息（当前状态）
            include_history: 是否包含历史版本列表
            include_edges: 是否包含出边列表
            include_children: 是否包含子节点列表
            
        Returns:
            {
                "entity_id": str,
                "basic": { ... } or None,          # 当前 state（最新 version）
                "history": [ ... ],                # 对应 get_entity_states
                "edges": [ ... ],                  # 对应 get_outbound_direct_edges
                "children": [ ... ]                # 子节点列表 (BELONGS_TO 边指向此节点的实体)
            }
            如果 Entity 不存在（连 basic 都没有），则返回 None
        """
        with self.driver.session() as session:
            # 1. Check existence and get basic info if requested
            basic_info = None
            if include_basic:
                basic_result = session.run("""
                    MATCH (s:State {entity_id: $entity_id})
                    RETURN s.id as state_id, s.version as version, s.content as content,
                           s.created_at as created_at, s.task_description as task_description,
                           s.name as name, s.entity_id as entity_id, s.inheritable as inheritable
                    ORDER BY s.version DESC
                    LIMIT 1
                """, entity_id=entity_id)
                record = basic_result.single()
                if record:
                    # Ensure types are JSON-serializable and match response schema
                    basic_info = {
                        "state_id": record["state_id"],
                        "version": record["version"],
                        "content": record["content"],
                        "created_at": str(record["created_at"]),
                        "task_description": record.get("task_description"),
                        "name": record["name"],
                        "entity_id": record["entity_id"],
                        "inheritable": record["inheritable"],
                    }
                else:
                    # If we wanted basic info but found nothing, the entity effectively doesn't exist
                    # However, to be safe, we check if we can find ANY state.
                    # The query above finds the latest state. If no state, entity is effectively gone/empty.
                    return None

            # If we didn't request basic, we still need to verify entity exists or just run other queries?
            # Usually, if we ask for history/edges, we assume entity exists.
            # But to conform to the "return None if not found" contract,
            # we might need to check existence if include_basic is False.
            # For simplicity, let's assume if include_basic is False, the caller is responsible,
            # OR we just return empty lists for history/edges if not found.
            # But the return type implies a dict wrapper.
            
            # Let's ensure we return a dict structure if the entity exists.
            # If include_basic=False, we check existence cheaply if needed, or just proceed.
            # Actually, let's just proceed.
            
            history = []
            if include_history:
                history_result = session.run("""
                    MATCH (s:State {entity_id: $entity_id})
                    RETURN s.id as state_id, s.version as version, 
                           s.created_at as created_at, s.task_description as task_description
                    ORDER BY s.version DESC
                """, entity_id=entity_id)
                for record in history_result:
                    history.append({
                        "state_id": record["state_id"],
                        "version": record["version"],
                        "created_at": str(record["created_at"]),
                        "task_description": record.get("task_description")
                    })

            edges = []
            if include_edges:
                edges_result = session.run("""
                    MATCH (from_s:State)-[d:DIRECT_EDGE]->(to_s:State)
                    WHERE d.from_entity_id = $entity_id
                    
                    OPTIONAL MATCH ()-[r:RELAY_EDGE]->()
                    WHERE r.parent_direct_edge_id = d.edge_id
                      AND r.part = 1
                    
                    RETURN d.to_entity_id as target_entity_id,
                           to_s.name as target_name,
                           d.relation as relation,
                           d.content as content,
                           d.inheritable as inheritable,
                           from_s.version as viewer_version,
                           to_s.version as target_version,
                           count(r) as relay_count
                    ORDER BY target_entity_id
                """, entity_id=entity_id)
                
                for record in edges_result:
                    content = record["content"] or ""
                    snippet = content[:100] + " [truncated]" if len(content) > 100 else content
                    
                    edges.append({
                        "target_entity_id": record["target_entity_id"],
                        "target_name": record["target_name"] or "Unnamed",
                        "relation": record["relation"],
                        "content_snippet": snippet,
                        "inheritable": record["inheritable"],
                        "viewer_version": record["viewer_version"],
                        "target_version": record["target_version"],
                        "relay_count": record["relay_count"]
                    })

            # Query children if requested
            children = []
            if include_children:
                children_result = session.run("""
                    MATCH (child:Entity)-[:BELONGS_TO]->(parent:Entity {id: $entity_id})
                    MATCH (child)-[:CURRENT]->(s:State)
                    RETURN child.id as entity_id,
                           s.id as state_id,
                           s.name as name,
                           labels(child) as labels,
                           s.content as content,
                           s.version as version,
                           s.created_at as created_at,
                           s.task_description as task_description
                    ORDER BY s.name
                    LIMIT 50
                """, entity_id=entity_id)
                
                for record in children_result:
                    # 获取第一个非 Entity 的标签作为类型
                    labels = record["labels"]
                    node_type = "unknown"
                    for label in labels:
                        if label != "Entity":
                            node_type = label
                            break
                    
                    content = record["content"] or ""
                    snippet = content[:100] + " [truncated]" if len(content) > 100 else content
                    
                    children.append({
                        "entity_id": record["entity_id"],
                        "state_id": record["state_id"],
                        "name": record["name"] or "Unnamed",
                        "node_type": node_type,
                        "content": content,
                        "content_snippet": snippet,
                        "version": record["version"],
                        "created_at": str(record["created_at"]) if record["created_at"] else "",
                        "task_description": record.get("task_description"),
                        # 占位的统计字段，避免为每个子节点再跑一次图查询
                        "in_count": 0,
                        "out_count": 0,
                    })

            # Construct result
            # If include_basic was True and we found nothing, we returned None earlier.
            # If include_basic was False, we return the dict with what we found.
            return {
                "entity_id": entity_id,
                "basic": basic_info,
                "history": history,
                "edges": edges,
                "children": children
            }

    def get_state_info(self, state_id: str) -> Optional[Dict[str, Any]]:
        """
        根据state_id获取State节点信息及统计数据
        """
        with self.driver.session() as session:
            query = """
            MATCH (s:State {id: $state_id})
            
            // 计算入边 (排除 CURRENT, PREVIOUS)
            OPTIONAL MATCH (other)-[r_in]->(s)
            WHERE type(r_in) <> 'CURRENT' AND type(r_in) <> 'PREVIOUS'
            WITH s, count(r_in) as in_count
            
            // 计算出边 (排除 PREVIOUS)
            // 注意: PREVIOUS 是出边 (new -> old)
            OPTIONAL MATCH (s)-[r_out]->(other)
            WHERE type(r_out) <> 'PREVIOUS'
            WITH s, in_count, count(r_out) as out_count
            
            RETURN s.id as state_id, s.entity_id as entity_id, s.version as version,
                   s.content as content, s.created_at as created_at,
                   s.task_description as task_description, s.name as name,
                   s.inheritable as inheritable,
                   in_count, out_count
            """
            result = session.run(query, state_id=state_id)
            record = result.single()
            if not record:
                return None
            # Ensure JSON-serializable primitives (Neo4j DateTime -> str, counts -> int)
            return {
                "state_id": record["state_id"],
                "entity_id": record["entity_id"],
                "version": record["version"],
                "name": record["name"],
                "content": record["content"],
                "created_at": str(record["created_at"]) if record.get("created_at") is not None else "",
                "task_description": record.get("task_description"),
                # keep inheritable for callers that need it (response_model will ignore extras)
                "inheritable": record.get("inheritable"),
                "in_count": int(record["in_count"]) if record.get("in_count") is not None else 0,
                "out_count": int(record["out_count"]) if record.get("out_count") is not None else 0,
            }

    def delete_state(self, state_id: str) -> Dict[str, Any]:
        """
        删除一个State版本

        - 如果是CURRENT版本，将CURRENT指向PREVIOUS
        - 删除前检查是否有入链引用此State（出链不阻止删除）
        - 如果有依赖（入链）则拒绝删除并返回依赖列表

        Args:
            state_id: State节点ID

        Raises:
            ValueError: 如果State不存在或有入链依赖

        Returns:
            {
                "deleted_state_id": str,
                "entity_id": str,
                "new_current_version": int or None  # 如果删除的是CURRENT，返回新的当前版本
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(self._delete_state_tx, state_id)
            return result

    @staticmethod
    def _delete_state_tx(tx, state_id: str):
        # 1. 检查State是否存在
        check_query = """
        MATCH (s:State {id: $state_id})
        RETURN s.entity_id as entity_id
        """
        check_result = tx.run(check_query, state_id=state_id)
        check_record = check_result.single()
        if not check_record:
            raise ValueError(f"State {state_id} not found")

        entity_id = check_record["entity_id"]

        # 2. 检查是否有入链（他人对该节点的记忆/引用）
        # 根据"Torch"理论：只要没有被别人记得（无入链），自己是否记得别人（出链）不影响消失。
        # 因此，只检查入链依赖，允许删除带有出链的节点（DETACH DELETE 会自动清理出链）。
        dependency_query = """
        MATCH (s:State {id: $state_id})
        OPTIONAL MATCH (s)<-[r_in]-(other_in)
        WHERE type(r_in) <> 'CURRENT' AND type(r_in) <> 'PREVIOUS'
        WITH s,
             collect(DISTINCT type(r_in)) as in_types,
             count(DISTINCT r_in) as in_count
        RETURN in_count, in_types
        """
        dep_result = tx.run(dependency_query, state_id=state_id)
        dep_record = dep_result.single()

        if dep_record["in_count"] > 0:
            raise ValueError(
                f"Cannot delete state {state_id}: "
                f"{dep_record['in_count']} incoming edges (references) still exist: "
                f"{dep_record['in_types']}"
            )

        # 3. 检查是否是CURRENT版本
        is_current_query = """
        MATCH (e:Entity)-[curr:CURRENT]->(s:State {id: $state_id})
        RETURN e, curr
        """
        is_current_result = tx.run(is_current_query, state_id=state_id)
        is_current = is_current_result.single() is not None

        new_current_version = None

        if is_current:
            # 删除CURRENT版本：CURRENT指向PREVIOUS
            delete_current_query = """
            MATCH (e:Entity)-[curr:CURRENT]->(s:State {id: $state_id})
            OPTIONAL MATCH (s)-[:PREVIOUS]->(prev:State)
            DELETE curr
            DETACH DELETE s
            WITH e, prev
            WHERE prev IS NOT NULL
            CREATE (e)-[:CURRENT {time: datetime()}]->(prev)
            RETURN prev.version as new_version
            """
            result = tx.run(delete_current_query, state_id=state_id)
            record = result.single()
            if record:
                new_current_version = record["new_version"]
        else:
            # 删除非CURRENT版本：重新连接PREVIOUS链（拔珠子）
            delete_query = """
            MATCH (s:State {id: $state_id})
            OPTIONAL MATCH (prev:State)-[p:PREVIOUS]->(s)
            OPTIONAL MATCH (s)-[n:PREVIOUS]->(next:State)
            WITH s, prev, next, p, n
            DELETE p, n
            WITH s, prev, next
            FOREACH (_ IN CASE WHEN prev IS NOT NULL AND next IS NOT NULL THEN [1] ELSE [] END |
                CREATE (prev)-[:PREVIOUS]->(next)
            )
            DETACH DELETE s
            """
            tx.run(delete_query, state_id=state_id)

        return {
            "deleted_state_id": state_id,
            "entity_id": entity_id,
            "new_current_version": new_current_version
        }

    def delete_entity(self, entity_id: str) -> Dict[str, Any]:
        """
        删除整个Entity（仅在其不再拥有任何State且自身无任何边时）

        Args:
            entity_id: Entity节点ID

        Raises:
            ValueError: 如果Entity不存在，或仍有State/任何边依赖

        Returns:
            {
                "deleted_entity_id": str,
                "deleted_states": List[str],  # 实际删除的State ID列表（当前语义下总为空）
                "deleted_edges": int  # 删除的边数量（当前语义下总为0）
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(self._delete_entity_tx, entity_id)
            return result

    @staticmethod
    def _delete_entity_tx(tx, entity_id: str):
        # 1. 检查Entity是否存在
        check_query = """
        MATCH (e:Entity {id: $entity_id})
        RETURN e
        """
        check_result = tx.run(check_query, entity_id=entity_id)
        if not check_result.single():
            raise ValueError(f"Entity {entity_id} not found")

        # 2. 检查是否仍然存在下属State（通过entity_id属性，而不是仅依赖CURRENT/PREVIOUS链）
        states_query = """
        MATCH (s:State)
        WHERE s.entity_id = $entity_id
        RETURN collect(DISTINCT s.id) as state_ids
        """
        states_result = tx.run(states_query, entity_id=entity_id)
        states_record = states_result.single()
        state_ids = states_record["state_ids"] if states_record else []

        if state_ids:
            raise ValueError(
                f"Cannot delete entity {entity_id}: it still has {len(state_ids)} state(s). "
                f"Delete states first."
            )

        # 3. 检查阻止删除的边
        # - 允许存在的边：Outgoing BELONGS_TO (此节点作为子节点)，将在删除时一并拆除
        # - 阻止删除的边：Incoming BELONGS_TO (此节点作为父节点)，或者其他任何类型的残留边
        edge_check_query = """
        MATCH (e:Entity {id: $entity_id})
        OPTIONAL MATCH (e)-[r]-(other)
        WHERE NOT (type(r) = 'BELONGS_TO' AND startNode(r) = e)
        RETURN count(r) as blocking_count, collect(DISTINCT type(r)) as blocking_types
        """
        edge_record = tx.run(edge_check_query, entity_id=entity_id).single()
        blocking_count = edge_record["blocking_count"] if edge_record else 0
        blocking_types = edge_record["blocking_types"] if edge_record else []

        if blocking_count > 0:
            raise ValueError(
                f"Cannot delete entity {entity_id}: {blocking_count} blocking edge(s) still attached "
                f"{blocking_types}. (Incoming BELONGS_TO means this entity is a parent and cannot be deleted yet)"
            )

        # 4. 计算将要随之删除的边数量 (Outgoing BELONGS_TO)
        count_outgoing_query = """
        MATCH (e:Entity {id: $entity_id})-[r:BELONGS_TO]->()
        RETURN count(r) as outgoing_count
        """
        out_record = tx.run(count_outgoing_query, entity_id=entity_id).single()
        deleted_edges = out_record["outgoing_count"] if out_record else 0

        # 5. 执行删除 (DETACH DELETE 会删除节点及其所有关联边)
        delete_query = """
        MATCH (e:Entity {id: $entity_id})
        DETACH DELETE e
        """
        tx.run(delete_query, entity_id=entity_id)

        return {
            "deleted_entity_id": entity_id,
            "deleted_states": state_ids,
            "deleted_edges": deleted_edges
        }

    # ==================== 边操作方法 ====================

    @staticmethod
    def _generate_edge_id(from_id: str, relation: str, to_id: str) -> str:
        """
        生成语义化的确定性Edge ID
        格式: {from_id}__{relation}__{to_id}
        使用双下划线作为分隔符，避免与单下划线混淆，保持可读性和可猜测性。
        """
        # 简单的清理：防止组件内部出现双下划线破坏结构
        # 替换掉组件内的 "__" 为 "_" (或者其他策略，这里选择降级处理以保证ID结构)
        safe_from = from_id.replace("__", "_")
        safe_rel = relation.replace("__", "_")
        safe_to = to_id.replace("__", "_")
        return f"{safe_from}__{safe_rel}__{safe_to}"

    @staticmethod
    def generate_relay_entity_id(from_entity_id: str, relation: str, to_entity_id: str) -> str:
        """
        根据 viewer, target, chapter_name 直接计算 Relay Entity ID。
        格式: relay__{from_entity_id}__{relation}__{to_entity_id}
        
        这是一个纯计算函数，不查询数据库。
        """
        return f"relay__{Neo4jClient._generate_edge_id(from_entity_id, relation, to_entity_id)}"

    def create_direct_edge(
        self,
        from_entity_id: str,
        to_entity_id: str,
        relation: str,
        content: str,
        inheritable: bool
    ) -> Dict[str, Any]:
        """
        创建1跳边 - 直接连接两个 Entity 的当前 State 节点（不可变历史记录）
        
        自动查找 Entity 的 CURRENT State。如果边已存在（同一对 Entity 之间），则抛出异常。

        Args:
            from_entity_id: 起始 Entity ID
            to_entity_id: 目标 Entity ID
            relation: 关系名称（自由命名）
            content: 详细描述正文
            inheritable: 是否可被子节点继承

        Raises:
            ValueError: 如果 Entity 不存在或边已存在

        Returns:
            {
                "edge_id": str,
                "from_state_id": str,
                "to_state_id": str,
                "from_entity_id": str,
                "to_entity_id": str,
                "relation": str,
                "created_at": str
            }
        """
        if from_entity_id == to_entity_id:
            raise ValueError(f"Self-referential relationships (from '{from_entity_id}' to itself) are not allowed. Information about the self belongs in the entity content/profile.")

        self._validate_no_double_underscore(relation, "relation")

        with self.driver.session() as session:
            result = session.execute_write(
                self._create_direct_edge_tx,
                from_entity_id,
                to_entity_id,
                relation,
                content,
                inheritable
            )
            return result

    @staticmethod
    def _create_direct_edge_tx(tx, from_entity_id: str, to_entity_id: str, relation: str, content: str, inheritable: bool):
        # 1. 查找当前的 State IDs
        lookup_query = """
        MATCH (from_e:Entity {id: $from_entity_id})-[:CURRENT]->(from_s:State)
        MATCH (to_e:Entity {id: $to_entity_id})-[:CURRENT]->(to_s:State)
        RETURN from_s.id as from_state_id, to_s.id as to_state_id
        """
        record = tx.run(
            lookup_query,
            from_entity_id=from_entity_id,
            to_entity_id=to_entity_id
        ).single()

        if not record:
             # 分别检查以提供更精确的报错
            from_check = tx.run(
                "MATCH (e:Entity {id: $id})-[:CURRENT]->(s:State) RETURN s",
                id=from_entity_id
            ).single()
            to_check = tx.run(
                "MATCH (e:Entity {id: $id})-[:CURRENT]->(s:State) RETURN s",
                id=to_entity_id
            ).single()

            missing = []
            if not from_check:
                missing.append(f"Entity '{from_entity_id}'")
            if not to_check:
                missing.append(f"Entity '{to_entity_id}'")

            raise ValueError(
                f"Cannot create direct edge: Current state not found for {', '.join(missing)}"
            )

        from_state_id = record["from_state_id"]
        to_state_id = record["to_state_id"]

        # 2. 生成语义化ID（按 Entity 维度唯一，而不是 State 维度）
        #    设计约束：同一对 (from_entity_id, to_entity_id) 之间在任一时刻只存在一条 DIRECT_EDGE。
        edge_id = Neo4jClient._generate_edge_id(from_entity_id, "DIRECT", to_entity_id)

        # 3. 检查这对 Entity 之间是否已经存在 DIRECT_EDGE，如有则拒绝创建
        #    注意：这里检查连接任意 State 的情况，因为逻辑上两个 Entity 之间只能有一条边
        existing_query = """
        MATCH (:State)-[r:DIRECT_EDGE]->(:State)
        WHERE r.edge_id = $edge_id
        RETURN r.edge_id as edge_id
        """
        existing = tx.run(
            existing_query,
            edge_id=edge_id
        ).single()
        
        if existing:
            raise ValueError(
                f"Direct edge already exists between entities '{from_entity_id}' and '{to_entity_id}' "
                f"(edge_id={existing['edge_id']}). Delete it explicitly before creating a new one."
            )

        # 4. 创建新的 DIRECT_EDGE，连接到当前指定的两个 State
        create_query = """
        MATCH (from:State {id: $from_state_id})
        MATCH (to:State {id: $to_state_id})
        CREATE (from)-[r:DIRECT_EDGE {
            edge_id: $edge_id,
            from_entity_id: $from_entity_id,
            to_entity_id: $to_entity_id,
            relation: $relation,
            content: $content,
            inheritable: $inheritable,
            created_at: datetime()
        }]->(to)
        RETURN r.edge_id as edge_id,
               r.created_at as created_at
        """
        result = tx.run(
            create_query,
            from_state_id=from_state_id,
            to_state_id=to_state_id,
            edge_id=edge_id,
            from_entity_id=from_entity_id,
            to_entity_id=to_entity_id,
            relation=relation,
            content=content,
            inheritable=inheritable
        )
        record = result.single()

        return {
            "edge_id": record["edge_id"],
            "from_state_id": from_state_id,
            "to_state_id": to_state_id,
            "from_entity_id": from_entity_id,
            "to_entity_id": to_entity_id,
            "relation": relation,
            "created_at": str(record["created_at"])
        }

    def get_direct_edge(self, from_entity_id: str, to_entity_id: str) -> Optional[Dict[str, Any]]:
        """
        获取两个 Entity 之间的 1跳边
        
        自动查找这两个 Entity 之间存在的 DIRECT_EDGE (edge_id 唯一)。

        Args:
            from_entity_id: 起始Entity节点ID
            to_entity_id: 目标Entity节点ID

        Returns:
            边的详细信息，如果不存在返回None
        """
        edge_id = self._generate_edge_id(from_entity_id, "DIRECT", to_entity_id)
        
        with self.driver.session() as session:
            result = session.run("""
                MATCH (from:State)-[r:DIRECT_EDGE {edge_id: $edge_id}]->(to:State)
                RETURN r.edge_id as edge_id,
                       r.from_entity_id as from_entity_id,
                       r.to_entity_id as to_entity_id,
                       r.relation as relation,
                       r.content as content,
                       r.inheritable as inheritable,
                       r.created_at as created_at,
                       from.id as from_state_id,
                       to.id as to_state_id
            """, edge_id=edge_id)
            record = result.single()
            if not record:
                return None
            return {
                "edge_id": record["edge_id"],
                "from_state_id": record["from_state_id"],
                "to_state_id": record["to_state_id"],
                "from_entity_id": record["from_entity_id"],
                "to_entity_id": record["to_entity_id"],
                "relation": record["relation"],
                "content": record["content"],
                "inheritable": record["inheritable"],
                "created_at": str(record["created_at"])
            }

    def delete_direct_edge(self, from_entity_id: str, to_entity_id: str, force: bool = False) -> Dict[str, Any]:
        """
        删除两个 Entity 之间的 1跳边

        默认行为带有依赖检查：
        - 如果存在通过该1跳边建立的2跳边（中继节点），则拒绝删除并抛出异常
        - 只有在不存在2跳边时，才会删除1跳边
        - 可通过 force=True 支持级联删除（删除相关的 RELAY_EDGE，保留中继 State 节点）

        Args:
            from_entity_id: 起始Entity节点ID
            to_entity_id: 目标Entity节点ID
            force: 是否强制删除依赖边

        Raises:
            ValueError: 如果边不存在，或存在依赖的2跳边且force=False

        Returns:
            {
                "from_entity_id": str,
                "to_entity_id": str,
                "deleted_relay_edges": int
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(
                self._delete_direct_edge_tx,
                from_entity_id,
                to_entity_id,
                force
            )
            return result

    @staticmethod
    def _delete_direct_edge_tx(tx, from_entity_id: str, to_entity_id: str, force: bool):
        edge_id = Neo4jClient._generate_edge_id(from_entity_id, "DIRECT", to_entity_id)

        # 检查边是否存在
        check_query = """
        MATCH ()-[r:DIRECT_EDGE {edge_id: $edge_id}]->()
        RETURN r.edge_id as direct_edge_id
        """
        check_result = tx.run(check_query, edge_id=edge_id)
        check_record = check_result.single()
        if not check_record:
            raise ValueError(
                f"Direct edge not found between entities {from_entity_id} and {to_entity_id}"
            )

        direct_edge_id = check_record["direct_edge_id"]

        # 依赖检查：是否存在通过该1跳边建立的2跳边（中继关系State）
        relay_info_query = """
        MATCH (:State)-[r:RELAY_EDGE]->(:State)
        WHERE r.parent_direct_edge_id = $direct_edge_id
        RETURN collect(DISTINCT r.edge_id) as relay_edge_ids,
               count(DISTINCT r.edge_id) as relay_count
        """
        relay_info_result = tx.run(
            relay_info_query,
            direct_edge_id=direct_edge_id
        )
        relay_info_record = relay_info_result.single() or {}
        relay_edge_ids = relay_info_record.get("relay_edge_ids") or []
        relay_count = relay_info_record.get("relay_count") or 0

        if relay_count > 0 and not force:
            raise ValueError(
                f"Cannot delete direct edge between {from_entity_id} and {to_entity_id}: "
                f"{relay_count} relay edges exist. Delete relay edges first "
                f"or call delete_direct_edge with force=True."
            )

        deleted_relay_count = 0
        if relay_count > 0 and force:
            # 级联删除所有关联的2跳边（通过统一的delete_relay_edge逻辑）
            for r_edge_id in relay_edge_ids:
                Neo4jClient._delete_relay_edge_tx(tx, r_edge_id)
            deleted_relay_count = len(relay_edge_ids)

        # 删除1跳边
        delete_query = """
        MATCH ()-[r:DIRECT_EDGE {edge_id: $edge_id}]->()
        DELETE r
        """
        tx.run(delete_query, edge_id=edge_id)

        return {
            "from_entity_id": from_entity_id,
            "to_entity_id": to_entity_id,
            "deleted_relay_edges": deleted_relay_count
        }

    def create_relay_edge(
        self,
        from_entity_id: str,
        to_entity_id: str,
        relation: str,
        content: str,
        inheritable: bool,
        parent_direct_edge_id: str
    ) -> Dict[str, Any]:
        """
        创建2跳边 - 通过中继节点连接（自动连接到Entity的当前State版本）
        
        如果该 relay entity 已存在，会抛出异常。
        更新已有的 relay 应使用 update_entity + link_via_relay_state。
        
        Args:
            from_entity_id: 起始Entity节点ID（用于生成稳定的 Relay Entity ID）
            to_entity_id: 目标Entity节点ID（用于生成稳定的 Relay Entity ID）
            relation: 关系的某个方面（2跳边的relation / chapter name）
            content: 储存在中继节点中的内容
            inheritable: 是否可被子节点继承
            parent_direct_edge_id: 依附的 DIRECT_EDGE ID
            
        Raises:
            ValueError: 如果 relay entity 已存在，或 Entity 找不到 Current State
            
        Returns:
            {
                "edge_id": str,
                "from_state_id": str,
                "to_state_id": str,
                "relay_node_id": str,
                "relation": str,
                "created_at": str
            }
        """
        self._validate_no_double_underscore(relation, "relation")
        
        # 所有读取和写入都封装在单个写事务中，避免读写之间的数据竞争
        with self.driver.session() as session:
            result = session.execute_write(
                self._create_relay_edge_tx,
                from_entity_id,
                to_entity_id,
                relation,
                content,
                inheritable,
                parent_direct_edge_id
            )
            return result

    def move_relay_edge(
        self,
        from_entity_id: str,
        to_entity_id: str,
        relay_state_id: str,
        parent_direct_edge_id: str
    ) -> Dict[str, Any]:
        """
        移动2跳边 (Relay Edge) 到 Entity 的最新 State（拆旧边，建新边）。
        
        自动查找 Entity 目前的 CURRENT State，并建立连接。
        通过计算稳定的 edge_id (基于 Entity ID)，先删除图中已存在的该逻辑边，
        然后在新版本的 State 之间建立连接。这确保了同一对 Entity 之间，
        同名（relation）的2跳边只存在一条（连接在最新的生效版本上）。
        
        Note: inheritable is stored on relay_state node, not on the edge.
        """
        with self.driver.session() as session:
            return session.execute_write(
                self._move_relay_edge_tx,
                from_entity_id,
                to_entity_id,
                relay_state_id,
                parent_direct_edge_id
            )

    @staticmethod
    def _move_relay_edge_tx(tx, from_entity_id, to_entity_id, relay_state_id, parent_direct_edge_id):
        # 1. 获取 Current State IDs
        def get_current_state_id(entity_id):
            query = "MATCH (e:Entity {id: $eid})-[:CURRENT]->(s:State) RETURN s.id as id"
            res = tx.run(query, eid=entity_id).single()
            if not res:
                raise ValueError(f"Current State for Entity {entity_id} not found")
            return res["id"]

        from_state_id = get_current_state_id(from_entity_id)
        to_state_id = get_current_state_id(to_entity_id)
            
        relay_res = tx.run("MATCH (s:State {id: $sid}) RETURN s", sid=relay_state_id).single()
        if not relay_res:
            raise ValueError(f"Relay State {relay_state_id} not found")

        relay_node = relay_res["s"]
        # 2. 生成 stable edge_id (基于 Entity IDs)
        # 我们需要 relation 名字来生成语义化 ID。从 Relay State 的 name 字段获取。
        relation_name = relay_node["name"] if "name" in relay_node else "unknown_relation"
        edge_id = Neo4jClient._generate_edge_id(from_entity_id, relation_name, to_entity_id)

        # 3. 拆旧边：删除图中已存在的该 edge_id 的所有 RELAY_EDGE
        # 这会断开旧版本的连接，但不会删除 Relay State 本身
        delete_query = """
        MATCH ()-[r:RELAY_EDGE {edge_id: $edge_id}]-()
        DELETE r
        """
        tx.run(delete_query, edge_id=edge_id)

        # 4. 建新边 (inheritable is stored on relay_state, not on edge)
        query = """
        MATCH (from:State {id: $from_state_id})
        MATCH (to:State {id: $to_state_id})
        MATCH (relay_state:State {id: $relay_state_id})
        
        CREATE (from)-[:RELAY_EDGE {
            edge_id: $edge_id,
            parent_direct_edge_id: $parent_direct_edge_id,
            part: 1,
            created_at: datetime()
        }]->(relay_state)
        
        CREATE (relay_state)-[:RELAY_EDGE {
            edge_id: $edge_id,
            parent_direct_edge_id: $parent_direct_edge_id,
            part: 2,
            created_at: datetime()
        }]->(to)
        
        RETURN $edge_id as edge_id
        """
        result = tx.run(
            query,
            from_state_id=from_state_id,
            to_state_id=to_state_id,
            relay_state_id=relay_state_id,
            edge_id=edge_id,
            parent_direct_edge_id=parent_direct_edge_id
        )
        return result.single()

    @staticmethod
    def _create_relay_edge_tx(
        tx,
        from_entity_id: str,
        to_entity_id: str,
        relation: str,
        content: str,
        inheritable: bool,
        parent_direct_edge_id: str
    ):
        """
        在单个事务中完成：
        1. 验证 parent_direct_edge_id 存在及其 inheritable 属性
        2. 查找 from/to Entity 的 CURRENT State
        3. 创建 Relay Entity、Relay State 以及两段 RELAY_EDGE
        """
        # 0. 验证 parent_direct_edge_id 是否存在及其 inheritable 属性
        parent_edge_query = """
        MATCH ()-[r:DIRECT_EDGE {edge_id: $edge_id}]->()
        RETURN r.inheritable as inheritable
        """
        parent_res = tx.run(parent_edge_query, edge_id=parent_direct_edge_id).single()
        if not parent_res:
            raise ValueError(f"Parent direct edge '{parent_direct_edge_id}' not found")

        # 如果父边不可继承，强制 relay 边也不可继承
        final_inheritable = inheritable
        if not parent_res["inheritable"]:
            final_inheritable = False

        # 1. 查找当前的 State IDs
        lookup_query = """
        MATCH (from_e:Entity {id: $from_entity_id})-[:CURRENT]->(from_s:State)
        MATCH (to_e:Entity {id: $to_entity_id})-[:CURRENT]->(to_s:State)
        RETURN from_s.id as from_state_id, to_s.id as to_state_id
        """
        record = tx.run(
            lookup_query,
            from_entity_id=from_entity_id,
            to_entity_id=to_entity_id
        ).single()

        if not record:
            # 分别检查以提供更精确的报错
            from_check = tx.run(
                "MATCH (e:Entity {id: $id})-[:CURRENT]->(s:State) RETURN s",
                id=from_entity_id
            ).single()
            to_check = tx.run(
                "MATCH (e:Entity {id: $id})-[:CURRENT]->(s:State) RETURN s",
                id=to_entity_id
            ).single()

            missing = []
            if not from_check:
                missing.append(f"Entity '{from_entity_id}'")
            if not to_check:
                missing.append(f"Entity '{to_entity_id}'")

            raise ValueError(
                f"Cannot create relay edge: Current state not found for {', '.join(missing)}"
            )

        from_state_id = record["from_state_id"]
        to_state_id = record["to_state_id"]

        # 2. 生成语义化 Relay Entity ID（基于 Entity ID）
        # 格式: relay__{from_entity_id}__{relation}__{to_entity_id}
        relay_node_id = Neo4jClient.generate_relay_entity_id(from_entity_id, relation, to_entity_id)
        relay_state_id = f"{relay_node_id}_v1"
        
        # 3. 检查是否已存在该 Relay Entity（create 只能用于首次创建）
        exist_query = """
        MATCH (relay:Entity {id: $relay_node_id})
        RETURN relay
        """
        exist_result = tx.run(exist_query, relay_node_id=relay_node_id)
        if exist_result.single():
            raise ValueError(
                f"Relay entity '{relay_node_id}' already exists. "
                f"Use update_entity + link_via_relay_state to update existing relay."
            )
        
        # 4. 生成语义化 Edge ID（用于 RELAY_EDGE，基于 Entity ID 保持跨版本唯一性）
        edge_id = Neo4jClient._generate_edge_id(from_entity_id, relation, to_entity_id)

        create_query = """
        MATCH (from:State {id: $from_state_id})
        MATCH (to:State {id: $to_state_id})
        
        CREATE (relay:Entity:Relationship {
            id: $relay_node_id,
            created_at: datetime(),
            is_relay: true,
            hidden: true,
            parent_direct_edge_id: $parent_direct_edge_id
        })
            
        CREATE (relay_state:State {
            id: $relay_state_id,
            entity_id: $relay_node_id,
            version: 1,
            name: $relation,
            content: $content,
            inheritable: $inheritable,
            created_at: datetime(),
            created_by: 'ai_agent',
            task_description: NULL,
            parent_direct_edge_id: $parent_direct_edge_id
        })
        
        CREATE (relay)-[:CURRENT {time: datetime()}]->(relay_state)
        
        CREATE (from)-[:RELAY_EDGE {
            edge_id: $edge_id,
            parent_direct_edge_id: $parent_direct_edge_id,
            part: 1,
            created_at: datetime()
        }]->(relay_state)
        CREATE (relay_state)-[:RELAY_EDGE {
            edge_id: $edge_id,
            parent_direct_edge_id: $parent_direct_edge_id,
            part: 2,
            created_at: datetime()
        }]->(to)
        RETURN $edge_id as edge_id,
            $relay_node_id as relay_node_id,
            datetime() as created_at
        """

        result = tx.run(
            create_query,
            from_state_id=from_state_id,
            to_state_id=to_state_id,
            edge_id=edge_id,
            relay_node_id=relay_node_id,
            relay_state_id=relay_state_id,
            parent_direct_edge_id=parent_direct_edge_id,
            relation=relation,
            content=content,
            inheritable=final_inheritable
        )
        record = result.single()

        return {
            "edge_id": record["edge_id"],
            "from_state_id": from_state_id,
            "to_state_id": to_state_id,
            "relay_node_id": record["relay_node_id"],
            "relation": relation,
            "created_at": str(record["created_at"])
        }

    def delete_relay_edge(self, edge_id: str) -> Dict[str, Any]:
        """
        删除指定的2跳边（只删RELAY_EDGE，不删除中继关系实体或其State）

        Args:
            edge_id: 边的唯一ID

        Raises:
            ValueError: 如果边不存在

        Returns:
            {
                "edge_id": str,
                "deleted": bool
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(
                self._delete_relay_edge_tx,
                edge_id
            )
            return result

    @staticmethod
    def _delete_relay_edge_tx(tx, edge_id: str):
        """
        删除指定的2跳边：删除所有 edge_id 匹配的 RELAY_EDGE，不自动删除中继关系实体或其State
        """
        # 检查该edge_id是否存在对应的RELAY_EDGE
        check_query = """
        MATCH ()-[r:RELAY_EDGE {edge_id: $edge_id}]-()
        RETURN count(r) as c
        """
        check_result = tx.run(check_query, edge_id=edge_id)
        check_record = check_result.single()
        if not check_record or check_record["c"] == 0:
            raise ValueError(f"Relay edge with id {edge_id} not found")

        # 删除所有对应的RELAY_EDGE，保留中继关系实体及其State
        delete_query = """
        MATCH ()-[r:RELAY_EDGE {edge_id: $edge_id}]-()
        DELETE r
        """
        tx.run(delete_query, edge_id=edge_id)

        return {
            "edge_id": edge_id,
            "deleted": True
        }

    def search_nodes(
        self,
        query: str,
        node_types: Optional[List[str]] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        搜索节点

        Args:
            query: 搜索关键词（支持多个关键词空格分隔）
            node_types: 节点类型过滤列表
            limit: 返回数量限制

        Returns:
            [
                {
                    "resource_id": str,
                    "name": str,
                    "node_type": str,
                    "match_snippet": str,
                    "score": float
                }
            ]
        """
        # 预处理搜索词：分割为空格分隔的关键词列表，并转为小写
        keywords = [k.lower() for k in query.split()]
        if not keywords:
            return []

        # 构建Cypher查询
        type_filter = ""
        if node_types:
            # 安全起见，验证node_types是否在允许列表中
            valid_types = [t for t in node_types if t in ALLOWED_NODE_TYPES.keys()]
            if valid_types:
                # 转换回Label名称
                labels = [ALLOWED_NODE_TYPES[t] for t in valid_types]
                labels_str = str(labels) # e.g. "['Character', 'Location']"
                type_filter = f"AND any(l in labels(e) WHERE l IN {labels_str})"

        # Entity 查询：要求所有关键词都必须出现在 id OR name OR content 中
        # 使用 all(kw IN $keywords WHERE ...) 实现 AND 逻辑
        cypher_query = f"""
        MATCH (e:Entity)-[:CURRENT]->(s:State)
        WHERE all(kw IN $keywords WHERE 
            toLower(e.id) CONTAINS kw OR 
            toLower(s.name) CONTAINS kw OR 
            toLower(s.content) CONTAINS kw
        )
        {type_filter}
        RETURN e.id as resource_id,
               s.name as name,
               labels(e) as labels,
               s.content as content
        """

        # Query for Edges (Direct Relationships)
        include_edges = True
        if node_types and "relationship" not in node_types:
            include_edges = False
            
        edge_query = ""
        if include_edges:
            # Edge 查询：同样要求所有关键词出现在 resource_id OR relation OR content 中
            # resource_id 构造为: rel:viewer_id>target_id
            edge_query = """
            UNION ALL
            MATCH (vs:State)-[r:DIRECT_EDGE]->(ts:State)
            WITH vs, ts, r, 'rel:' + vs.entity_id + '>' + ts.entity_id as edge_resource_id
            WHERE all(kw IN $keywords WHERE 
                toLower(edge_resource_id) CONTAINS kw OR 
                toLower(r.relation) CONTAINS kw OR 
                toLower(r.content) CONTAINS kw
            )
            RETURN edge_resource_id as resource_id,
                   vs.name + ' -> ' + ts.name + ' (' + r.relation + ')' as name,
                   ['DirectEdge'] as labels,
                   r.content as content
            """

        cypher_query = f"{cypher_query} {edge_query} LIMIT $limit"

        with self.driver.session() as session:
            result = session.run(cypher_query, {"keywords": keywords, "limit": limit})
            items = []
            for record in result:
                # 获取第一个非Entity的标签作为类型
                labels = record["labels"]
                node_type = "unknown"
                for label in labels:
                    if label != "Entity":
                        node_type = label
                        break

                content = record["content"]
                if content:
                    snippet = content[:100] + " [truncated]" if len(content) > 100 else content
                else:
                    snippet = None

                items.append({
                    "resource_id": record["resource_id"],
                    "name": record["name"] or "Unnamed",
                    "node_type": node_type,
                    "match_snippet": snippet,
                    "score": 1.0  # 简单的CONTAINS没有评分，默认1.0
                })
            return items

    # ==================== 父子关系管理方法 ====================

    def link_parent(self, child_id: str, parent_id: str) -> Dict[str, Any]:
        """
        建立子节点到父节点的 BELONGS_TO 边
        
        Args:
            child_id: 子节点 Entity ID
            parent_id: 父节点 Entity ID
            
        Raises:
            ValueError: 如果 child 或 parent 不存在，或关系已存在
            
        Returns:
            {
                "child_id": str,
                "parent_id": str,
                "created": bool
            }
        """
        if child_id == parent_id:
            raise ValueError("Cannot link an entity to itself as parent")
        
        with self.driver.session() as session:
            result = session.execute_write(
                self._link_parent_tx,
                child_id,
                parent_id
            )
            return result

    @staticmethod
    def _link_parent_tx(tx, child_id: str, parent_id: str):
        # 1. 验证两个 Entity 都存在
        check_query = """
        MATCH (child:Entity {id: $child_id})
        MATCH (parent:Entity {id: $parent_id})
        RETURN child, parent
        """
        check_result = tx.run(check_query, child_id=child_id, parent_id=parent_id)
        if not check_result.single():
            # 分别检查以提供更精确的报错
            child_check = tx.run(
                "MATCH (e:Entity {id: $id}) RETURN e",
                id=child_id
            ).single()
            parent_check = tx.run(
                "MATCH (e:Entity {id: $id}) RETURN e",
                id=parent_id
            ).single()
            
            missing = []
            if not child_check:
                missing.append(f"Child entity '{child_id}'")
            if not parent_check:
                missing.append(f"Parent entity '{parent_id}'")
            
            raise ValueError(f"Entity not found: {', '.join(missing)}")
        
        # 2. 检查关系是否已存在
        existing_query = """
        MATCH (child:Entity {id: $child_id})-[r:BELONGS_TO]->(parent:Entity {id: $parent_id})
        RETURN r
        """
        existing = tx.run(existing_query, child_id=child_id, parent_id=parent_id).single()
        if existing:
            raise ValueError(
                f"Parent-child relationship already exists: '{child_id}' -> '{parent_id}'"
            )

        # 2.5 检查是否存在直接的反向关系（防止2点互为父子）
        # 我们允许长链循环（A->B->C->A），但禁止直接的互为父子（A->B 且 B->A）
        reverse_query = """
        MATCH (parent:Entity {id: $parent_id})-[r:BELONGS_TO]->(child:Entity {id: $child_id})
        RETURN r
        """
        reverse_existing = tx.run(reverse_query, child_id=child_id, parent_id=parent_id).single()
        if reverse_existing:
            raise ValueError(
                f"Cannot link '{child_id}' -> '{parent_id}': Mutual parent-child relationship (2-node cycle) is not allowed. "
                f"'{parent_id}' is already a child of '{child_id}'."
            )
        
        # 3. 创建 BELONGS_TO 边
        create_query = """
        MATCH (child:Entity {id: $child_id})
        MATCH (parent:Entity {id: $parent_id})
        CREATE (child)-[:BELONGS_TO {created_at: datetime()}]->(parent)
        RETURN true as created
        """
        result = tx.run(create_query, child_id=child_id, parent_id=parent_id)
        result.single()
        
        return {
            "child_id": child_id,
            "parent_id": parent_id,
            "created": True
        }

    def unlink_parent(self, child_id: str, parent_id: str) -> Dict[str, Any]:
        """
        移除子节点到父节点的 BELONGS_TO 边
        
        Args:
            child_id: 子节点 Entity ID
            parent_id: 父节点 Entity ID
            
        Raises:
            ValueError: 如果关系不存在
            
        Returns:
            {
                "child_id": str,
                "parent_id": str,
                "deleted": bool
            }
        """
        with self.driver.session() as session:
            result = session.execute_write(
                self._unlink_parent_tx,
                child_id,
                parent_id
            )
            return result

    @staticmethod
    def _unlink_parent_tx(tx, child_id: str, parent_id: str):
        # 检查关系是否存在
        check_query = """
        MATCH (child:Entity {id: $child_id})-[r:BELONGS_TO]->(parent:Entity {id: $parent_id})
        RETURN r
        """
        check_result = tx.run(check_query, child_id=child_id, parent_id=parent_id)
        if not check_result.single():
            raise ValueError(
                f"No parent-child relationship found: '{child_id}' -> '{parent_id}'"
            )
        
        # 删除关系
        delete_query = """
        MATCH (child:Entity {id: $child_id})-[r:BELONGS_TO]->(parent:Entity {id: $parent_id})
        DELETE r
        """
        tx.run(delete_query, child_id=child_id, parent_id=parent_id)
        
        return {
            "child_id": child_id,
            "parent_id": parent_id,
            "deleted": True
        }

    def has_parent_link(self, child_id: str, parent_id: str) -> bool:
        """
        检查指定的父子关系是否存在。

        仅用于只关心“是否存在”而不需要完整子列表的场景，
        避免依赖带 LIMIT 的子节点查询导致误判。
        """
        with self.driver.session() as session:
            query = """
            MATCH (child:Entity {id: $child_id})-[r:BELONGS_TO]->(parent:Entity {id: $parent_id})
            RETURN r
            LIMIT 1
            """
            result = session.run(query, child_id=child_id, parent_id=parent_id)
            return result.single() is not None

    def get_children(self, parent_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        查询某 Entity 的所有子节点
        
        Args:
            parent_id: 父节点 Entity ID
            limit: 返回数量限制
            
        Returns:
            [
                {
                    "entity_id": str,
                    "name": str,
                    "node_type": str,
                    "content_snippet": str,
                    "version": int
                }
            ]
        """
        with self.driver.session() as session:
            query = """
            MATCH (child:Entity)-[:BELONGS_TO]->(parent:Entity {id: $parent_id})
            MATCH (child)-[:CURRENT]->(s:State)
            RETURN child.id as entity_id,
                   s.name as name,
                   labels(child) as labels,
                   s.content as content,
                   s.version as version
            ORDER BY s.name
            LIMIT $limit
            """
            result = session.run(query, parent_id=parent_id, limit=limit)
            
            children = []
            for record in result:
                # 获取第一个非 Entity 的标签作为类型
                labels = record["labels"]
                node_type = "unknown"
                for label in labels:
                    if label != "Entity":
                        node_type = label
                        break
                
                content = record["content"] or ""
                snippet = content[:100] + " [truncated]" if len(content) > 100 else content
                
                children.append({
                    "entity_id": record["entity_id"],
                    "name": record["name"] or "Unnamed",
                    "node_type": node_type,
                    "content_snippet": snippet,
                    "version": record["version"]
                })
            
            return children

    def get_relationship_structure(self, viewer_entity_id: str, target_entity_id: str) -> Dict[str, Any]:
        """
        获取两个 Entity 之间的最新关系结构。
        
        查找逻辑：
        利用 State.entity_id 索引，直接查找属于两个 Entity 的 State 集合之间存在的边。
        由于关系可能因懒更新而停留在旧版本上，我们按 Viewer State 的版本号倒序排序，
        取最新的一个（LIMIT 1）。
        """
        with self.driver.session() as session:
            query = """
            // 直接匹配两组 State 之间的 Direct Edge
            MATCH (v:State)-[d:DIRECT_EDGE]->(t:State)
            WHERE v.entity_id = $viewer_entity_id 
              AND t.entity_id = $target_entity_id
            
            // 按 Viewer 版本倒序，取最新的那次关系记录
            WITH v, d, t
            ORDER BY v.version DESC
            LIMIT 1
            
            // 查找依附于该 DIRECT_EDGE 的 RELAY_EDGEs
            OPTIONAL MATCH (v)-[r1:RELAY_EDGE]->(relay:State)-[r2:RELAY_EDGE]->(t)
            WHERE r1.edge_id = r2.edge_id 
              AND r1.parent_direct_edge_id = d.edge_id

            // 先在 WITH 中完成聚合，避免在同一返回列中混用聚合与分组表达式
            WITH v, d, t,
                 collect(
                     CASE WHEN relay IS NOT NULL THEN {
                         edge_id: r1.edge_id,
                         state: relay {.*, created_at: toString(relay.created_at)},
                         relation: relay.name,
                         inheritable: relay.inheritable
                     } ELSE NULL END
                 ) AS relays
            
            RETURN {
                viewer_state: {
                    id: v.id,
                    version: v.version,
                    name: v.name,
                    entity_id: v.entity_id
                },
                target_state: {
                    id: t.id,
                    version: t.version,
                    name: t.name,
                    entity_id: t.entity_id
                },
                direct: d {.*, created_at: toString(d.created_at)},
                relays: relays
            } as result
            """
            result = session.run(query, viewer_entity_id=viewer_entity_id, target_entity_id=target_entity_id)
            record = result.single()
            
            if not record:
                 return {"direct": None, "relays": []}
                  
            return record["result"]

    def evolve_relationship(
        self,
        viewer_entity_id: str,
        target_entity_id: str,
        direct_patch: Optional[Dict[str, Any]] = None,
        chapter_updates: Optional[Dict[str, Dict[str, Any]]] = None,
        new_chapters: Optional[Dict[str, Dict[str, Any]]] = None,
        task_description: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        演化一对 Entity 之间的关系到最新版本，同时可选地更新多个位点的内容。
        
        这个函数执行"边搬家"操作：
        1. 获取当前的关系结构（1跳边 + 所有2跳边）
        2. Evolve Viewer（创建新版本的 viewer state）
        3. 创建新的 1跳边 (Direct Edge)（连接到 target 的 CURRENT state）
        4. 创建新的 chapters（如果有 new_chapters）
        5. 对于每个现有 chapter：
           - 如果 chapter_updates 中有更新，先用 update_entity 创建新版本
           - 然后用 move_relay_edge 迁移到新的位置
        
        Args:
            viewer_entity_id: 观察者 Entity ID
            target_entity_id: 目标 Entity ID
            direct_patch: 1跳边 (Direct Edge) 的更新字典，可包含：
                - content: str (新内容，None 表示保持不变)
                - relation: str (关系名称，None 表示保持不变)
                - inheritable: bool (是否可继承，None 表示保持不变)
            chapter_updates: 要更新的现有 chapter，格式为：
                {chapter_name: {"content": str (可选), "inheritable": bool (可选)}}
            new_chapters: 要创建的新 chapter，格式为：
                {chapter_name: {"content": str, "inheritable": bool (可选，默认 True)}}
            task_description: 任务描述
            
        Raises:
            ValueError: 如果 viewer 或 target 不存在，或关系不存在
            
        Returns:
            {
                "viewer_entity_id": str,
                "target_entity_id": str,
                "viewer_new_version": int,
                "viewer_new_state_id": str,
                "direct_edge_id": str,
                "created_chapters": List[str],  # 新创建的 chapter 名称列表
                "updated_chapters": List[str],  # 被更新内容的 chapter 名称列表
                "migrated_chapters": List[str]  # 所有迁移的 chapter 名称列表
            }
        """
        direct_patch = direct_patch or {}
        chapter_updates = chapter_updates or {}
        new_chapters = new_chapters or {}
        
        # ========== 1. 获取当前关系结构 ==========
        rel_data = self.get_relationship_structure(viewer_entity_id, target_entity_id)
        
        # 验证关系存在
        if not rel_data.get('direct'):
            raise ValueError(
                f"No relationship found from '{viewer_entity_id}' to '{target_entity_id}'. "
                f"Use create_direct_edge first."
            )
        
        # 获取当前的 direct edge 属性（用于保持不变的情况）
        current_direct = rel_data['direct']
        final_direct_content = direct_patch.get('content') if direct_patch.get('content') is not None else current_direct.get('content', '')
        final_direct_relation = direct_patch.get('relation') if direct_patch.get('relation') is not None else current_direct.get('relation', 'RELATIONSHIP')
        final_direct_inheritable = direct_patch.get('inheritable') if direct_patch.get('inheritable') is not None else current_direct.get('inheritable', True)
        
        # 获取所有现有的 relay 信息
        existing_relays = rel_data.get('relays', [])
        # 过滤掉 None 值（collect 可能包含 NULL）
        existing_relays = [r for r in existing_relays if r is not None]
        
        # ========== 2. 获取 Viewer 和 Target 的当前状态 ==========
        viewer_info = self.get_entity_info(
            viewer_entity_id,
            include_basic=True,
            include_history=False,
            include_edges=False,
        )
        viewer_state = viewer_info["basic"] if viewer_info else None
        if not viewer_state:
            raise ValueError(f"Viewer entity '{viewer_entity_id}' not found.")
        
        target_info = self.get_entity_info(
            target_entity_id,
            include_basic=True,
            include_history=False,
            include_edges=False,
        )
        target_state = target_info["basic"] if target_info else None
        if not target_state:
            raise ValueError(f"Target entity '{target_entity_id}' not found.")
        
        # ========== 3. Evolve Viewer（创建新版本） ==========
        task_desc = task_description or "Relationship evolution"
        new_viewer_res = self.update_entity(
            viewer_entity_id,
            new_content=viewer_state['content'],  # 保持 viewer 自身内容不变
            task_description=task_desc
        )
        new_viewer_state_id = new_viewer_res['state_id']
        
        # ========== 3.5 删除旧的 Direct Edge ==========
        # 必须先删除旧边及其依附的 Relay Edges，才能创建同名的新 Direct Edge。
        # 我们使用 force=True 来移除旧的 RELAY_EDGE 关系（Chapter State 节点保留），
        # 随后在步骤 6 中会将这些 Chapter 重新连接到新的 Direct Edge 上。
        self.delete_direct_edge(viewer_entity_id, target_entity_id, force=True)

        # ========== 4. 创建新的 Direct Edge ==========
        # 连接 new_viewer_state -> target's CURRENT state
        direct_res = self.create_direct_edge(
            viewer_entity_id,
            target_entity_id,
            relation=final_direct_relation,
            content=final_direct_content,
            inheritable=final_direct_inheritable
        )
        parent_edge_id = direct_res['edge_id']
        
        # ========== 5. 创建新的 Chapters ==========
        created_chapters = []
        for chapter_name, chapter_data in new_chapters.items():
            # 只支持完整形式 {chapter_name: {"content": ..., "inheritable": ...}}
            chapter_content = chapter_data.get('content', '')
            chapter_inheritable = chapter_data.get('inheritable', True)
            
            self.create_relay_edge(
                from_entity_id=viewer_entity_id,
                to_entity_id=target_entity_id,
                relation=chapter_name,
                content=chapter_content,
                inheritable=chapter_inheritable,
                parent_direct_edge_id=parent_edge_id
            )
            created_chapters.append(chapter_name)
        
        # ========== 6. 处理现有 Chapter（更新 + 迁移） ==========
        updated_chapters = []
        migrated_chapters = []
        
        for relay_info in existing_relays:
            relay_state = relay_info['state']
            chapter_name = relay_state.get('name', '')
            relay_entity_id = relay_state.get('entity_id')
            
            # 确定要使用的 relay_state_id
            relay_state_id = relay_state.get('id')
            
            # 检查是否需要更新这个 chapter
            if chapter_name in chapter_updates:
                update_data = chapter_updates[chapter_name]
                
                new_content = update_data.get('content')
                new_inheritable = update_data.get('inheritable')
                
                # 如果有任何更新，调用 update_entity 创建新版本
                if new_content is not None or new_inheritable is not None:
                    # 如果没有提供 new_content，使用当前 content
                    content_to_use = new_content if new_content is not None else relay_state.get('content', '')
                    
                    update_res = self.update_entity(
                        relay_entity_id,
                        new_content=content_to_use,
                        new_inheritable=new_inheritable,
                        task_description=f"Chapter update: {chapter_name}"
                    )
                    relay_state_id = update_res['state_id']
                    updated_chapters.append(chapter_name)
            
            # 迁移 relay edge 到新的位置
            self.move_relay_edge(
                viewer_entity_id,
                target_entity_id,
                relay_state_id,
                parent_edge_id
            )
            migrated_chapters.append(chapter_name)
        
        return {
            "viewer_entity_id": viewer_entity_id,
            "target_entity_id": target_entity_id,
            "viewer_new_version": new_viewer_res['new_version'],
            "viewer_new_state_id": new_viewer_state_id,
            "direct_edge_id": parent_edge_id,
            "created_chapters": created_chapters,
            "updated_chapters": updated_chapters,
            "migrated_chapters": migrated_chapters
        }

    def find_orphan_states(
        self,
        mode: str = "in_zero",
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        查找闲置的 State 节点（可以被安全清理的旧版本）
        
        Args:
            mode: 查询模式
                - "in_zero": 仅入边为0（更宽松，可能有出边但没人引用）
                - "all_zero": 出边入边都为0（最严格，完全孤立）
            limit: 返回数量限制
            
        Returns:
            [
                {
                    "state_id": str,
                    "entity_id": str,
                    "version": int,
                    "name": str,
                    "content_snippet": str,
                    "created_at": str,
                    "is_current": bool,       # 是否是 CURRENT 版本
                    "in_count": int,          # 入边数量（排除 CURRENT, PREVIOUS）
                    "out_count": int,         # 出边数量（排除 PREVIOUS）
                    "entity_type": str        # Entity 类型（Character, Location, etc.）
                }
            ]
            
        Note:
            - 排除的边类型：
              - CURRENT: Entity -> State 的当前版本指针
              - PREVIOUS: State -> State 的版本链指针
            - 业务边类型：DIRECT_EDGE, RELAY_EDGE 等
            - is_current=True 的节点通常不应该删除（除非要删除整个 Entity）
        """
        with self.driver.session() as session:
            # 构建查询
            # 1. 对于每个 State，计算其入边和出边数量（排除版本管理边）
            # 2. 根据 mode 过滤
            # 3. 返回符合条件的 State 列表
            
            if mode == "all_zero":
                where_clause = "in_count = 0 AND out_count = 0"
            else:  # in_zero (default)
                where_clause = "in_count = 0"
            
            query = f"""
            MATCH (s:State)
            
            // 计算入边（排除 CURRENT, PREVIOUS）
            OPTIONAL MATCH (other_in)-[r_in]->(s)
            WHERE type(r_in) <> 'CURRENT' AND type(r_in) <> 'PREVIOUS'
            WITH s, count(DISTINCT r_in) as in_count
            
            // 计算出边（排除 PREVIOUS，因为 PREVIOUS 是 new->old）
            OPTIONAL MATCH (s)-[r_out]->(other_out)
            WHERE type(r_out) <> 'PREVIOUS'
            WITH s, in_count, count(DISTINCT r_out) as out_count
            
            // 检查是否是 CURRENT 版本
            OPTIONAL MATCH (e:Entity)-[curr:CURRENT]->(s)
            WITH s, in_count, out_count, (curr IS NOT NULL) as is_current
            
            // 根据 mode 过滤
            WHERE {where_clause}
            
            // 获取 Entity 信息
            OPTIONAL MATCH (entity:Entity {{id: s.entity_id}})
            
            RETURN s.id as state_id,
                   s.entity_id as entity_id,
                   s.version as version,
                   s.name as name,
                   s.content as content,
                   s.created_at as created_at,
                   is_current,
                   in_count,
                   out_count,
                   labels(entity) as entity_labels
            ORDER BY s.entity_id, s.version DESC
            LIMIT $limit
            """
            
            result = session.run(query, limit=limit)
            orphans = []
            
            for record in result:
                content = record["content"] or ""
                snippet = content[:150] + "..." if len(content) > 150 else content
                
                # 获取 Entity 类型（排除 "Entity" 标签）
                entity_labels = record["entity_labels"] or []
                entity_type = "unknown"
                for label in entity_labels:
                    if label != "Entity":
                        entity_type = label
                        break
                
                orphans.append({
                    "state_id": record["state_id"],
                    "entity_id": record["entity_id"],
                    "version": record["version"],
                    "name": record["name"] or "Unnamed",
                    "content_snippet": snippet,
                    "created_at": str(record["created_at"]) if record["created_at"] else None,
                    "is_current": record["is_current"],
                    "in_count": record["in_count"],
                    "out_count": record["out_count"],
                    "entity_type": entity_type
                })
            
            return orphans

    def find_orphan_entities(self, limit: int = 100) -> List[Dict[str, Any]]:
        """
        查找孤儿 Entity
        
        判定标准（必须同时满足）：
        1. 没有任何下属 State（没有版本记录）。
        2. 没有任何“阻止删除”的边。
           - 允许存在：Outgoing BELONGS_TO (自己是子节点)
           - 阻止存在：Incoming BELONGS_TO (自己是父节点)，或其他任何类型的边
        
        Args:
            limit: 返回数量限制
            
        Returns:
            [
                {
                    "entity_id": str,
                    "name": str,
                    "node_type": str,
                    "created_at": str,
                }
            ]
        """
        with self.driver.session() as session:
            # 核心逻辑：找出所有 Entity
            # 1. 排除有 State 的
            # 2. 排除有“阻止删除”边的
            query = """
            MATCH (e:Entity)
            WHERE NOT EXISTS {
                MATCH (s:State)
                WHERE s.entity_id = e.id
            }
            AND NOT EXISTS {
                MATCH (e)-[r]-(other)
                WHERE NOT (type(r) = 'BELONGS_TO' AND startNode(r) = e)
            }
            
            WITH e, labels(e) as entity_labels
            
            RETURN e.id as entity_id,
                   e.name as name,
                   e.created_at as created_at,
                   entity_labels
            ORDER BY e.id
            LIMIT $limit
            """
            
            result = session.run(query, limit=limit)
            orphans = []
            
            for record in result:
                # 获取 Entity 类型（排除 "Entity" 标签）
                entity_labels = record["entity_labels"] or []
                node_type = "unknown"
                for label in entity_labels:
                    if label != "Entity":
                        node_type = label
                        break
                
                orphans.append({
                    "entity_id": record["entity_id"],
                    "name": record["name"] or "Unnamed",
                    "node_type": node_type,
                    "created_at": str(record["created_at"]) if record["created_at"] else None,
                })
            
            return orphans

    def get_catalog_data(self) -> List[Dict[str, Any]]:
        """
        获取目录数据：所有实体及其当前状态，包括所有出链（Direct Edges）和章节数量。
        """
        with self.driver.session() as session:
            query = """
            MATCH (e:Entity)-[:CURRENT]->(s:State)
            // 排除隐藏节点（如 Relay Entity）
            WHERE NOT COALESCE(e.hidden, false)
            
            // 查找所有出边（Direct Edges）
            OPTIONAL MATCH (v:State)-[d:DIRECT_EDGE]->(target_state:State)
            WHERE v.entity_id = e.id
            
            // 计算依附于该 DIRECT_EDGE 的 RELAY_EDGEs (Chapters) 数量
            OPTIONAL MATCH (v)-[r1:RELAY_EDGE]->(:State)
            WHERE r1.parent_direct_edge_id = d.edge_id 
              AND r1.part = 1
            
            WITH e, s, v, d, target_state, count(r1) as chapter_count
            ORDER BY e.id, d.to_entity_id, v.version DESC
            
            // 按 Entity 聚合 Direct Edges
            WITH e, s, collect(
                CASE WHEN d IS NOT NULL THEN {
                    target_entity_id: d.to_entity_id,
                    relation: d.relation,
                    target_name: target_state.name,
                    edge_id: d.edge_id,
                    chapter_count: chapter_count
                } ELSE NULL END
            ) as all_edges
            
            RETURN e.id as entity_id,
                   s.name as name,
                   labels(e) as labels,
                   all_edges as edges
            ORDER BY e.id
            """
            result = session.run(query)
            
            catalog = []
            for record in result:
                # Filter out 'Entity' from labels to get the specific type
                node_types = [label for label in record["labels"] if label != "Entity"]
                node_type = node_types[0] if node_types else "unknown"
                
                # Filter null edges
                edges = [e for e in record["edges"] if e is not None]
                
                # Deduplicate edges by target_entity_id
                seen_targets = set()
                unique_edges = []
                for edge in edges:
                    target_id = edge["target_entity_id"]
                    if target_id not in seen_targets:
                        seen_targets.add(target_id)
                        unique_edges.append(edge)
                
                catalog.append({
                    "entity_id": record["entity_id"],
                    "name": record["name"],
                    "node_type": node_type,
                    "edges": unique_edges
                })
            
            return catalog


# 全局单例
_neo4j_client: Optional[Neo4jClient] = None


def get_neo4j_client() -> Neo4jClient:
    """获取Neo4j客户端单例"""
    global _neo4j_client
    if _neo4j_client is None:
        # 从环境变量读取配置
        uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
        user = os.getenv("dbuser", "neo4j")
        password = os.getenv("dbpassword", "password")

        _neo4j_client = Neo4jClient(
            uri=uri,
            user=user,
            password=password
        )
    return _neo4j_client


def close_neo4j_client():
    """关闭Neo4j客户端连接"""
    global _neo4j_client
    if _neo4j_client:
        _neo4j_client.close()
        _neo4j_client = None
