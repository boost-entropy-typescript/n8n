import { Container } from 'typedi';
import { GlobalConfig } from '@n8n/config';
import type { IRun, WorkflowExecuteMode } from 'n8n-workflow';
import {
	QueryFailedError,
	type DataSource,
	type EntityManager,
	type EntityMetadata,
} from '@n8n/typeorm';
import { mocked } from 'jest-mock';
import { mock } from 'jest-mock-extended';

import config from '@/config';
import type { User } from '@db/entities/User';
import type { WorkflowStatistics } from '@db/entities/WorkflowStatistics';
import { WorkflowStatisticsRepository } from '@db/repositories/workflowStatistics.repository';
import { WorkflowStatisticsService } from '@/services/workflow-statistics.service';
import { UserService } from '@/services/user.service';
import { OwnershipService } from '@/services/ownership.service';
import { mockInstance } from '@test/mocking';
import type { Project } from '@/databases/entities/Project';

describe('WorkflowStatisticsService', () => {
	const fakeUser = mock<User>({ id: 'abcde-fghij' });
	const fakeProject = mock<Project>({ id: '12345-67890', type: 'personal' });
	const ownershipService = mockInstance(OwnershipService);
	const userService = mockInstance(UserService);
	const globalConfig = Container.get(GlobalConfig);
	const dbType = globalConfig.database.type;

	const entityManager = mock<EntityManager>();
	const dataSource = mock<DataSource>({
		manager: entityManager,
		getMetadata: () =>
			mock<EntityMetadata>({
				tableName: 'workflow_statistics',
			}),
	});
	Object.assign(entityManager, { connection: dataSource });

	config.set('diagnostics.enabled', true);
	config.set('deployment.type', 'n8n-testing');
	mocked(ownershipService.getWorkflowProjectCached).mockResolvedValue(fakeProject);
	mocked(ownershipService.getProjectOwnerCached).mockResolvedValue(fakeUser);
	const updateSettingsMock = jest.spyOn(userService, 'updateSettings').mockImplementation();

	const workflowStatisticsService = new WorkflowStatisticsService(
		mock(),
		new WorkflowStatisticsRepository(dataSource, globalConfig),
		ownershipService,
		userService,
	);

	const onFirstProductionWorkflowSuccess = jest.fn();
	const onFirstWorkflowDataLoad = jest.fn();
	workflowStatisticsService.on(
		'telemetry.onFirstProductionWorkflowSuccess',
		onFirstProductionWorkflowSuccess,
	);
	workflowStatisticsService.on('telemetry.onFirstWorkflowDataLoad', onFirstWorkflowDataLoad);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	const mockDBCall = (count = 1) => {
		if (dbType === 'sqlite') {
			entityManager.findOne.mockResolvedValueOnce(mock<WorkflowStatistics>({ count }));
		} else {
			const result = dbType === 'postgresdb' ? [{ count }] : { affectedRows: count };
			entityManager.query.mockImplementationOnce(async (query) =>
				query.startsWith('INSERT INTO') ? result : null,
			);
		}
	};

	describe('workflowExecutionCompleted', () => {
		test('should create metrics for production successes', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflow = {
				id: '1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData: IRun = {
				finished: true,
				status: 'success',
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			mockDBCall();

			await workflowStatisticsService.workflowExecutionCompleted(workflow, runData);
			expect(updateSettingsMock).toHaveBeenCalledTimes(1);
			expect(onFirstProductionWorkflowSuccess).toBeCalledTimes(1);
			expect(onFirstProductionWorkflowSuccess).toHaveBeenNthCalledWith(1, {
				project_id: fakeProject.id,
				user_id: fakeUser.id,
				workflow_id: workflow.id,
			});
		});

		test('should only create metrics for production successes', async () => {
			// Call the function with a non production success result, ensure metrics hook is never called
			const workflow = {
				id: '1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData: IRun = {
				finished: false,
				status: 'error',
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			await workflowStatisticsService.workflowExecutionCompleted(workflow, runData);
			expect(onFirstProductionWorkflowSuccess).toBeCalledTimes(0);
		});

		test('should not send metrics for updated entries', async () => {
			// Call the function with a fail insert, ensure update is called *and* metrics aren't sent
			const workflow = {
				id: '1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData: IRun = {
				finished: true,
				status: 'success',
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			mockDBCall(2);
			await workflowStatisticsService.workflowExecutionCompleted(workflow, runData);
			expect(onFirstProductionWorkflowSuccess).toBeCalledTimes(0);
		});
	});

	describe('nodeFetchedData', () => {
		test('should create metrics when the db is updated', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflowId = '1';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
			};
			await workflowStatisticsService.nodeFetchedData(workflowId, node);
			expect(onFirstWorkflowDataLoad).toBeCalledTimes(1);
			expect(onFirstWorkflowDataLoad).toHaveBeenNthCalledWith(1, {
				user_id: fakeUser.id,
				project_id: fakeProject.id,
				workflow_id: workflowId,
				node_type: node.type,
				node_id: node.id,
			});
		});

		test('should create metrics with credentials when the db is updated', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflowId = '1';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
				credentials: {
					testCredentials: {
						id: '1',
						name: 'Test Credentials',
					},
				},
			};
			await workflowStatisticsService.nodeFetchedData(workflowId, node);
			expect(onFirstWorkflowDataLoad).toBeCalledTimes(1);
			expect(onFirstWorkflowDataLoad).toHaveBeenNthCalledWith(1, {
				user_id: fakeUser.id,
				project_id: fakeProject.id,
				workflow_id: workflowId,
				node_type: node.type,
				node_id: node.id,
				credential_type: 'testCredentials',
				credential_id: node.credentials.testCredentials.id,
			});
		});

		test('should not send metrics for entries that already have the flag set', async () => {
			// Fetch data for workflow 2 which is set up to not be altered in the mocks
			entityManager.insert.mockRejectedValueOnce(new QueryFailedError('', undefined, new Error()));
			const workflowId = '1';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
			};
			await workflowStatisticsService.nodeFetchedData(workflowId, node);
			expect(onFirstWorkflowDataLoad).toBeCalledTimes(0);
		});
	});
});
